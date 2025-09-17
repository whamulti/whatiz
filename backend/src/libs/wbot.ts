import * as Sentry from "@sentry/node";
import makeWASocket, {
  WASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  CacheStore,
  WAMessageKey,
  WAMessageContent,
  proto,
  jidNormalizedUser,
  BinaryNode
} from "baileys";

import { Boom } from "@hapi/boom";
// import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger";
import NodeCache from "node-cache";
import { Op } from "sequelize";
import { Agent } from "https";
import { Mutex } from "async-mutex";
import useVoiceCallsBaileys from "voice-calls-baileys";
import {
  ClientToServerEvents,
  ServerToClientEvents
} from "voice-calls-baileys/lib/services/transport.type";
import { Socket } from "socket.io-client";
import Whatsapp from "../models/Whatsapp";
import { logger, loggerBaileys } from "../utils/logger";
import authState from "../helpers/authState";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import Contact from "../models/Contact";
import Ticket from "../models/Ticket";
import { GitInfo } from "../gitinfo";
import GetPublicSettingService from "../services/SettingServices/GetPublicSettingService";
import waVersion from "../waversion.json";
import Message from "../models/Message";
import OutOfTicketMessage from "../models/OutOfTicketMessages";
import BaileysKeys from "../models/BaileysKeys";
import { DecoupledDriverServices } from "../services/DecoupledDriverServices/DecoupledDriverServices";
import ShowTicketService from "../services/TicketServices/ShowTicketService";
import GetTicketWbot from "../helpers/GetTicketWbot";
import { getJidOf } from "../services/WbotServices/getJidOf";

// const loggerBaileys = MAIN_LOGGER.child({});
// loggerBaileys.level = process.env.BAILEYS_LOG_LEVEL || "error";

export type Session = WASocket & {
  id?: number;
  myJid?: string;
  myLid?: string;
  cacheMessage?: (msg: proto.IWebMessageInfo) => void;
  isRefreshing?: boolean;
};

const sessions: Session[] = [];

const retriesQrCodeMap = new Map<number, number>();

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }
  return sessions[sessionIndex];
};

export const removeWbot = async (
  whatsappId: number,
  isLogout = true
): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        await sessions[sessionIndex].logout();
      }

      sessions[sessionIndex].ev.removeAllListeners("connection.update");
      sessions[sessionIndex].ev.removeAllListeners("creds.update");
      sessions[sessionIndex].ev.removeAllListeners("presence.update");
      sessions[sessionIndex].ev.removeAllListeners("groups.upsert");
      sessions[sessionIndex].ev.removeAllListeners("groups.update");
      sessions[sessionIndex].ev.removeAllListeners("group-participants.update");
      sessions[sessionIndex].ev.removeAllListeners("contacts.upsert");
      sessions[sessionIndex].ev.removeAllListeners("contacts.update");
      sessions[sessionIndex].end(null);

      sessions[sessionIndex].ws.removeAllListeners();
      await sessions[sessionIndex].ws.close();
      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
  if (isLogout) {
    await BaileysKeys.destroy({
      where: { whatsappId }
    });
  }
};

function getGreaterVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const numA = a[i] || 0;
    const numB = b[i] || 0;

    if (numA > numB) {
      return a;
    }
    if (numA < numB) {
      return b;
    }
  }

  return a;
}

const waVersionCache = new NodeCache({
  stdTTL: 60 * 60 * 24, // 24 hours
  checkperiod: 60 * 30, // 30 minutes
  useClones: false
});

const waVersionMutex = new Mutex();

const getProjectWAVersion = async () => {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/ticketz-oss/ticketz/refs/heads/main/backend/src/waversion.json"
    );
    const version = await res.json();
    return version;
  } catch (error) {
    logger.warn("Failed to get current WA Version from project repository");
  }
  return waVersion;
};

export const initWASocket = async (
  whatsapp: Whatsapp,
  proxy?: Agent,
  isRefresh = false
): Promise<Session> => {
  return new Promise((resolve, reject) => {
    try {
      (async () => {
        const io = getIO();

        const whatsappUpdate = await Whatsapp.findOne({
          where: { id: whatsapp.id }
        });

        if (!whatsappUpdate) return;

        const { id, name, provider } = whatsappUpdate;

        const autoVersion = await waVersionMutex.runExclusive(async () => {
          let wv = waVersionCache.get("waVersion");

          if (!wv) {
            wv = await getProjectWAVersion();

            if (!wv) {
              // anything will be greater
              return [2, 2300, 0];
            }

            waVersionCache.set("waVersion", wv);
          }

          return wv;
        });

        const isLegacy = provider === "stable";

        const version = getGreaterVersion(autoVersion, waVersion);

        logger.info(`using WA v${version.join(".")}`);
        logger.info(`isLegacy: ${isLegacy}`);
        logger.info(`Starting session ${name}`);
        let retriesQrCode = 0;

        let wsocket: Session = null;
        const store = new NodeCache({
          stdTTL: 120,
          checkperiod: 30,
          useClones: false
        });

        async function getMessage(
          key: WAMessageKey
        ): Promise<WAMessageContent> {
          if (!key.id) return null;

          const message = store.get(key.id);

          if (message) {
            logger.debug({ message }, "cacheMessage: recovered from cache");
            return message;
          }

          logger.debug(
            { key },
            "cacheMessage: not found in cache - fallback to database"
          );

          let msg: Message | OutOfTicketMessage;

          msg = await Message.findOne({
            where: { id: key.id, fromMe: true }
          });

          if (!msg) {
            msg = await OutOfTicketMessage.findOne({
              where: { id: key.id }
            });
          }

          if (!msg) {
            logger.debug({ key }, "cacheMessage: not found in database");
            return undefined;
          }

          try {
            const data = JSON.parse(msg.dataJson);
            logger.debug(
              { key, data },
              "cacheMessage: recovered from database"
            );
            store.set(key.id, data.message);
            return data.message || undefined;
          } catch (error) {
            logger.error(
              { key },
              `cacheMessage: error parsing message from database - ${error.message}`
            );
          }

          return undefined;
        }

        const { state, saveState } = await authState(whatsapp);

        const msgRetryCounterCache = new NodeCache();
        const userDevicesCache: CacheStore = new NodeCache();
        const internalGroupCache = new NodeCache({
          stdTTL: 5 * 60,
          useClones: false
        });
        const groupCache: CacheStore = {
          get: <T>(key: string): T => {
            logger.debug(`groupCache.get ${key}`);
            const value = internalGroupCache.get(key);
            if (!value) {
              logger.debug(`groupCache.get ${key} not found`);
              wsocket.groupMetadata(key).then(async metadata => {
                logger.debug({ key, metadata }, `groupCache.get ${key} set`);
                internalGroupCache.set(key, metadata);
              });
            }
            return value as T;
          },
          set: async (key: string, value: any) => {
            logger.debug({ key, value }, `groupCache.set ${key}`);
            return internalGroupCache.set(key, value);
          },
          del: async (key: string) => {
            logger.debug(`groupCache.del ${key}`);
            return internalGroupCache.del(key);
          },
          flushAll: async () => {
            logger.debug("groupCache.flushAll");
            return internalGroupCache.flushAll();
          }
        };

        const appName =
          (await GetPublicSettingService({ key: "appName" })) || "Ticketz";
        const hostName = process.env.BACKEND_URL?.split("/")[2];
        const appVersion = GitInfo.tagName || GitInfo.commitHash;
        const clientName = `${appName} ${appVersion}${
          hostName ? ` - ${hostName}` : ""
        }`;

        wsocket = makeWASocket({
          logger: loggerBaileys,
          printQRInTerminal: false,
          emitOwnEvents: false,
          markOnlineOnConnect: false,
          browser: [clientName, "Desktop", appVersion],
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, loggerBaileys)
          },
          version,
          defaultQueryTimeoutMs: 60000,
          // retryRequestDelayMs: 250,
          // keepAliveIntervalMs: 1000 * 60 * 10 * 3,
          msgRetryCounterCache,
          // syncFullHistory: true,
          generateHighQualityLinkPreview: true,
          userDevicesCache,
          getMessage,
          agent: proxy,
          fetchAgent: proxy,
          cachedGroupMetadata: async jid => groupCache.get(jid),
          shouldIgnoreJid: jid =>
            isJidBroadcast(jid) || jid?.endsWith("@newsletter"),
          transactionOpts: { maxCommitRetries: 1, delayBetweenTriesMs: 10 }
        });

        wsocket.ev.on("call", async event => {
          logger.trace({ event }, "Received call event");
        });

        wsocket.ws.on("CB:call", async (node: BinaryNode) => {
          logger.trace({ node }, "Received raw call node");
        });

        wsocket.isRefreshing = isRefresh;

        wsocket.cacheMessage = (msg: proto.IWebMessageInfo): void => {
          if (!msg.key.fromMe) return;

          logger.debug({ message: msg.message }, "cacheMessage: saved");

          store.set(msg.key.id, msg.message);
        };

        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            logger.info(
              { lastDisconnect },
              `Socket  ${name} Connection Update ${connection || ""}`
            );

            if (connection === "close") {
              if ((lastDisconnect?.error as Boom)?.output?.statusCode === 403) {
                // disconnected from whatsapp
                await removeWbot(id);
                await whatsapp.update({
                  status: "DISCONNECTED",
                  session: "",
                  qrcode: ""
                });
                await DeleteBaileysService(whatsapp.id);
                io.to(`company-${whatsapp.companyId}-admin`).emit(
                  `company-${whatsapp.companyId}-whatsappSession`,
                  {
                    action: "update",
                    session: whatsapp
                  }
                );
              }
              if (
                (lastDisconnect?.error as Boom)?.output?.statusCode !==
                DisconnectReason.loggedOut
              ) {
                // connection dropped without logging out
                await whatsapp.update({ status: "PENDING" });
                io.to(`company-${whatsapp.companyId}-admin`).emit(
                  `company-${whatsapp.companyId}-whatsappSession`,
                  {
                    action: "update",
                    session: whatsapp
                  }
                );
                removeWbot(id, false).then(() => {
                  logger.info(`Reconnecting ${name} in 2 seconds`);
                  setTimeout(async () => {
                    await whatsapp.reload();
                    await StartWhatsAppSession(
                      whatsapp,
                      whatsapp.companyId,
                      true
                    );
                  }, 2000);
                });
              } else {
                // logged out
                await removeWbot(id);
                await whatsapp.update({
                  status: "DISCONNECTED",
                  session: "",
                  qrcode: ""
                });
                await DeleteBaileysService(whatsapp.id);
                io.to(`company-${whatsapp.companyId}-admin`).emit(
                  `company-${whatsapp.companyId}-whatsappSession`,
                  {
                    action: "update",
                    session: whatsapp
                  }
                );
              }
            }

            if (connection === "open") {
              await whatsapp.reload({
                include: ["wavoip"]
              });
              if (whatsapp.wavoip) {
                useVoiceCallsBaileys(
                  whatsapp.wavoip.token,
                  wsocket,
                  "open",
                  true
                )
                  .then(
                    (
                      wavoipSocket: Socket<
                        ServerToClientEvents,
                        ClientToServerEvents
                      >
                    ) => {
                      wavoipSocket.onAny((event, ...args) => {
                        logger.trace(
                          { event, args },
                          `Wavoip event received: ${event}`
                        );
                      });
                    }
                  )
                  .catch(error => {
                    logger.error(
                      { message: error.message },
                      `Error initializing Wavoip for session ${name}`
                    );
                  });
              }

              wsocket.myLid = jidNormalizedUser(wsocket.user?.lid);
              wsocket.myJid = jidNormalizedUser(wsocket.user.id);

              await whatsapp.update({
                status: "CONNECTED",
                qrcode: "",
                retries: 0
              });

              logger.debug(
                {
                  id: jidNormalizedUser(wsocket.user.id),
                  name: wsocket.user.name,
                  lid: jidNormalizedUser(wsocket.user?.lid),
                  notify: wsocket.user?.notify,
                  verifiedName: wsocket.user?.verifiedName,
                  imgUrl: wsocket.user?.imgUrl,
                  status: wsocket.user?.status
                },
                `Session ${name} details`
              );

              io.to(`company-${whatsapp.companyId}-admin`).emit(
                `company-${whatsapp.companyId}-whatsappSession`,
                {
                  action: "update",
                  session: whatsapp
                }
              );

              const sessionIndex = sessions.findIndex(
                s => s.id === whatsapp.id
              );
              if (sessionIndex === -1) {
                wsocket.id = whatsapp.id;
                sessions.push(wsocket);
              }

              if (wsocket.isRefreshing) {
                setTimeout(() => {
                  wsocket
                    .resyncAppState(
                      [
                        "critical_block",
                        "critical_unblock_low",
                        "regular_high",
                        "regular_low",
                        "regular"
                      ],
                      true
                    )
                    .catch(error => {
                      logger.error(
                        { message: error.message },
                        `Error resyncing app state for session ${name}`
                      );
                    });
                }, 5000);
                wsocket.isRefreshing = false;
              }
              resolve(wsocket);
            }

            if (qr !== undefined) {
              if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id) >= 3) {
                await whatsappUpdate.update({
                  status: "DISCONNECTED",
                  qrcode: ""
                });
                await DeleteBaileysService(whatsappUpdate.id);
                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsappUpdate
                });
                wsocket.ev.removeAllListeners("connection.update");
                wsocket.ws.close();
                wsocket = null;
                retriesQrCodeMap.delete(id);
              } else {
                logger.info(`Session QRCode Generate ${name}`);
                retriesQrCodeMap.set(id, (retriesQrCode += 1));

                await whatsapp.update({
                  qrcode: qr,
                  status: "qrcode",
                  retries: 0
                });
                const sessionIndex = sessions.findIndex(
                  s => s.id === whatsapp.id
                );

                if (sessionIndex === -1) {
                  wsocket.id = whatsapp.id;
                  sessions.push(wsocket);
                }

                io.to(`company-${whatsapp.companyId}-admin`).emit(
                  `company-${whatsapp.companyId}-whatsappSession`,
                  {
                    action: "update",
                    session: whatsapp
                  }
                );
              }
            }
          }
        );
        wsocket.ev.on("creds.update", saveState);

        wsocket.ev.on(
          "presence.update",
          async ({ id: remoteJid, presences }) => {
            try {
              logger.debug(
                { remoteJid, presences },
                "Received contact presence"
              );
              if (!presences[remoteJid]?.lastKnownPresence) {
                // ignore presence from groups
                return;
              }
              const contact = await Contact.findOne({
                where: {
                  number: remoteJid.replace(/\D/g, ""),
                  companyId: whatsapp.companyId
                }
              });
              if (!contact) {
                return;
              }
              const ticket = await Ticket.findOne({
                where: {
                  contactId: contact.id,
                  whatsappId: whatsapp.id,
                  status: {
                    [Op.or]: ["open", "pending"]
                  }
                }
              });

              if (ticket) {
                io.to(ticket.id.toString())
                  .to(`company-${whatsapp.companyId}-${ticket.status}`)
                  .to(`queue-${ticket.queueId}-${ticket.status}`)
                  .emit(`company-${whatsapp.companyId}-presence`, {
                    ticketId: ticket.id,
                    presence: presences[remoteJid].lastKnownPresence
                  });
              }
            } catch (error) {
              logger.error(
                { remoteJid, presences },
                "presence.update: error processing"
              );
              if (error instanceof Error) {
                logger.error(`Error: ${error.name} ${error.message}`);
              } else {
                logger.error(`Error was object of type: ${typeof error}`);
              }
            }
          }
        );

        wsocket.ev.on("groups.upsert", groups => {
          logger.debug("Received new group");
          groups.forEach(group => {
            groupCache.set(group.id, group);
          });
        });

        wsocket.ev.on("groups.update", async ([event]) => {
          logger.debug("Received group update");
          const metadata = await wsocket.groupMetadata(event.id);
          groupCache.set(event.id, metadata);
        });

        wsocket.ev.on("group-participants.update", async event => {
          logger.debug("Received group participants update");
          try {
            const metadata = await wsocket.groupMetadata(event.id);
            groupCache.set(event.id, metadata);
          } catch (error) {
            groupCache.del(event.id);
          }
        });
      })();
    } catch (error) {
      Sentry.captureException(error);
      console.log(error);
      reject(error);
    }
  });
};

const decoupledDriverServices = DecoupledDriverServices.getInstance();

decoupledDriverServices.registerFunction(
  "presenceUpdate",
  async (user, parameters) => {
    const { ticketId, presence } = parameters;
    const ticket = await ShowTicketService(ticketId);
    if (!ticket || ticket.companyId !== user.companyId) {
      return;
    }

    const wbot = await GetTicketWbot(ticket);
    if (!wbot) {
      return;
    }

    const jid = getJidOf(ticket);

    if (jid.endsWith("@lid")) {
      return;
    }

    wbot.sendPresenceUpdate(presence, jid).catch(err => {
      logger.error(
        {
          message: err.message,
          jid,
          presence,
          ticketId: ticket.id,
          companyId: ticket.companyId,
          connection: ticket.whatsapp?.name
        },
        "Error sending presence update"
      );
    });
  }
);
