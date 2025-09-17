import path from "path";
import * as Sentry from "@sentry/node";
import { isNil, head, keys } from "lodash";

import {
  WASocket,
  downloadContentFromMessage,
  extractMessageContent,
  getContentType,
  jidNormalizedUser,
  MessageUpsertType,
  proto,
  WAMessage,
  WAMessageUpdate,
  WAMessageStubType,
  WAGenericMediaMessage
} from "baileys";
import { Mutex } from "async-mutex";
import { Op } from "sequelize";
import moment from "moment";
import { Transform } from "stream";
import { Throttle } from "stream-throttle";
import { Sequelize } from "sequelize-typescript";
import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";
import OldMessage from "../../models/OldMessage";

import { getIO } from "../../libs/socket";
import CreateMessageService, {
  websocketCreateMessage
} from "../MessageServices/CreateMessageService";
import { logger } from "../../utils/logger";
import FindOrCreateTicketService from "../TicketServices/FindOrCreateTicketService";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";
import UpdateTicketService, {
  UpdateTicketData
} from "../TicketServices/UpdateTicketService";
import formatBody from "../../helpers/Mustache";
import TicketTraking from "../../models/TicketTraking";
import UserRating from "../../models/UserRating";
import SendWhatsAppMessage from "./SendWhatsAppMessage";
import Queue from "../../models/Queue";
import QueueOption from "../../models/QueueOption";
import VerifyCurrentSchedule, {
  ScheduleResult
} from "../CompanyService/VerifyCurrentSchedule";
import Campaign from "../../models/Campaign";
import CampaignShipping from "../../models/CampaignShipping";
import { campaignQueue } from "../../queues/campaign";
import User from "../../models/User";
import Setting from "../../models/Setting";
import { debounce } from "../../helpers/Debounce";
import { getMessageFileOptions, MediaInfo } from "./SendWhatsAppMedia";
import { makeRandomId } from "../../helpers/MakeRandomId";
import CheckSettings, { GetCompanySetting } from "../../helpers/CheckSettings";
import Whatsapp from "../../models/Whatsapp";
import { SimpleObjectCache } from "../../helpers/simpleObjectCache";
import { getPublicPath } from "../../helpers/GetPublicPath";
import { Session } from "../../libs/wbot";
import { checkCompanyCompliant } from "../../helpers/CheckCompanyCompliant";
import { transcriber } from "../../helpers/transcriber";
import { parseToMilliseconds } from "../../helpers/parseToMilliseconds";
import { randomValue } from "../../helpers/randomValue";
import { getJidOf } from "./getJidOf";
import { verifyContact } from "./verifyContact";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import saveMediaToFile from "../../helpers/saveMediaFile";
import { _t } from "../TranslationServices/i18nService";

export interface ImessageUpsert {
  messages: proto.IWebMessageInfo[];
  type: MessageUpsertType;
}

interface IMe {
  name: string;
  id: string;
}

const wbotMutex = new Mutex();
const ackMutex = new Mutex();

const groupContactCache = new SimpleObjectCache(1000 * 30, logger);
const outOfHoursCache = new SimpleObjectCache(1000 * 60 * 5, logger);

const getTypeMessage = (msg: proto.IWebMessageInfo): string => {
  return getContentType(msg.message);
};

const msgLocation = (
  image:
    | Uint8Array
    | ArrayBuffer
    | { valueOf(): ArrayBuffer | SharedArrayBuffer },
  latitude: number,
  longitude: number
) => {
  if (image) {
    const b64 = Buffer.from(image).toString("base64");

    const data = `data:image/png;base64, ${b64} | https://maps.google.com/maps?q=${latitude}%2C${longitude}&z=17&hl=pt-BR|${latitude}, ${longitude} `;
    return data;
  }
  return "";
};

export const getBodyFromTemplateMessage = (
  templateMessage: proto.Message.ITemplateMessage
) => {
  return (
    templateMessage.hydratedTemplate?.hydratedContentText ||
    templateMessage.interactiveMessageTemplate?.body?.text ||
    "unsupported templateMessage"
  );
};

export const getBodyMessage = (msg: proto.IMessage): string | null => {
  try {
    if (!msg) {
      return "";
    }

    const type = getContentType(msg);

    const types = {
      conversation: msg?.conversation,
      editedMessage:
        msg?.editedMessage?.message?.protocolMessage?.editedMessage
          ?.conversation,
      imageMessage: msg?.imageMessage?.caption,
      videoMessage: msg?.videoMessage?.caption,
      extendedTextMessage: msg?.extendedTextMessage?.text,
      buttonsMessage: msg?.buttonsMessage?.contentText,
      listMessage: msg?.listMessage?.description,
      templateMessage:
        msg?.templateMessage && getBodyFromTemplateMessage(msg.templateMessage),
      buttonsResponseMessage: msg?.buttonsResponseMessage?.selectedButtonId,
      templateButtonReplyMessage: msg?.templateButtonReplyMessage?.selectedId,
      messageContextInfo:
        msg?.buttonsResponseMessage?.selectedButtonId ||
        msg?.listResponseMessage?.title,
      viewOnceMessageV2:
        msg?.viewOnceMessageV2?.message?.imageMessage?.caption || "",
      stickerMessage: "sticker",
      contactMessage:
        msg?.contactMessage?.vcard &&
        JSON.stringify({
          ticketzvCard: [
            {
              displayName: msg.contactMessage.displayName,
              vcard: msg.contactMessage.vcard
            }
          ]
        }),
      contactsArrayMessage:
        msg?.contactsArrayMessage &&
        JSON.stringify({
          ticketzvCard: msg.contactsArrayMessage.contacts
        }),
      // locationMessage: `Latitude: ${msg.locationMessage?.degreesLatitude} - Longitude: ${msg.locationMessage?.degreesLongitude}`,
      locationMessage: msgLocation(
        msg?.locationMessage?.jpegThumbnail,
        msg?.locationMessage?.degreesLatitude,
        msg?.locationMessage?.degreesLongitude
      ),
      liveLocationMessage: `Latitude: ${msg?.liveLocationMessage?.degreesLatitude} - Longitude: ${msg?.liveLocationMessage?.degreesLongitude}`,
      documentMessage: msg?.documentMessage?.caption,
      documentWithCaptionMessage:
        msg?.documentWithCaptionMessage?.message?.documentMessage?.caption,
      audioMessage: "🔊",
      listResponseMessage:
        msg?.listResponseMessage?.singleSelectReply?.selectedRowId,
      reactionMessage: msg?.reactionMessage?.text || "reaction"
    };

    const objKey = Object.keys(types).find(key => key === type);

    if (!objKey) {
      logger.warn({ type, msg }, "received unsupported message");
      return `unsupported message: ${type}`;
    }
    let body = types[type] || "";
    if (!body && type !== "imageMessage") {
      logger.debug({ msg, type }, "Body is empty");
    }
    if (typeof body !== "string") {
      body = "unsupported body content";
    }
    return body;
  } catch (error) {
    logger.error({ error, msg }, `getBodyMessage: error: ${error?.message}`);
    return null;
  }
};

type QuotedMessage = {
  quotedId: string;
  quotedMsg: proto.IMessage | undefined;
  participant: string;
};

/**
 * @description: extract quoted message info from a message
 * @param {proto.IWebMessageInfo} msg - message to extract quoted info from
 * @return {QuotedMessage} - object containing quotedId and quotedMsg
 */
const getQuotedMessage = (msg: proto.IWebMessageInfo): QuotedMessage => {
  const message = extractMessageContent(msg.message)[
    Object.keys(msg?.message).values().next().value
  ];

  return {
    quotedId:
      message?.contextInfo?.stanzaId || msg?.message?.reactionMessage?.key?.id,
    quotedMsg: message?.contextInfo?.quotedMessage,
    participant: message?.contextInfo?.participant
  };
};

const getMeSocket = (wbot: Session): IMe => {
  return {
    id: jidNormalizedUser((wbot as WASocket).user.id),
    name: (wbot as WASocket).user.name
  };
};

const getSenderMessage = (
  msg: proto.IWebMessageInfo,
  wbot: Session
): string => {
  const me = getMeSocket(wbot);
  if (msg.key.fromMe) return me.id;

  const senderId =
    msg.participant || msg.key.participant || msg.key.remoteJid || undefined;

  return senderId && jidNormalizedUser(senderId);
};

const getContactMessage = async (msg: proto.IWebMessageInfo, wbot: Session) => {
  const isGroup = msg.key.remoteJid.includes("g.us");
  const rawNumber = msg.key.remoteJid.replace(/\D/g, "");
  return isGroup
    ? {
        id: getSenderMessage(msg, wbot),
        name: msg.pushName
      }
    : {
        id: msg.key.remoteJid,
        name: msg.key.fromMe ? rawNumber : msg.pushName
      };
};

const getUnpackedMessage = (msg: proto.IWebMessageInfo) => {
  return (
    msg.message?.documentWithCaptionMessage?.message ||
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message ||
    msg.message?.viewOnceMessageV2?.message ||
    msg.message?.ephemeralMessage?.message ||
    msg.message?.templateMessage?.hydratedTemplate ||
    msg.message?.templateMessage?.hydratedFourRowTemplate ||
    msg.message?.templateMessage?.fourRowTemplate ||
    msg.message?.interactiveMessage?.header ||
    msg.message?.highlyStructuredMessage?.hydratedHsm?.hydratedTemplate ||
    msg.message
  );
};

const getMessageMedia = (message: proto.IMessage) => {
  return (
    message?.imageMessage ||
    message?.audioMessage ||
    message?.videoMessage ||
    message?.stickerMessage ||
    message?.documentMessage ||
    message?.documentWithCaptionMessage?.message?.documentMessage ||
    message?.templateMessage?.interactiveMessageTemplate?.header
      ?.imageMessage ||
    message?.templateMessage?.interactiveMessageTemplate?.header
      ?.videoMessage ||
    message?.templateMessage?.interactiveMessageTemplate?.header
      ?.documentMessage ||
    null
  );
};

const downloadStream = async (stream: Transform): Promise<Buffer> => {
  const MAX_SPEED = (5 * 1024 * 1024) / 8; // 5Mbps
  const THROTTLE_SPEED = (1024 * 1024) / 8; // 1Mbps
  const LARGE_FILE_SIZE = 1024 * 1024; // 1 MiB

  const throttle = new Throttle({ rate: MAX_SPEED });
  let buffer = Buffer.from([]);
  let totalSize = 0;

  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of stream.pipe(throttle)) {
      buffer = Buffer.concat([buffer, chunk]);
      totalSize += chunk.length;

      if (totalSize > LARGE_FILE_SIZE) {
        throttle.rate = THROTTLE_SPEED;
      }
    }
  } catch (error) {
    Sentry.setExtra("ERR_WAPP_DOWNLOAD_MEDIA", { error });
    Sentry.captureException(new Error("ERR_WAPP_DOWNLOAD_MEDIA"));
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  return buffer;
};

type ThumbnailMessage = {
  mediaKey?: Uint8Array | null;
  thumbnailDirectPath?: string | null;
  mimetype?: string;
};

export const normalizeThumbnailMediaType = (
  mimetype: string
): "thumbnail-video" | "thumbnail-image" | "thumbnail-document" => {
  const types = ["thumbnail-video", "thumbnail-image", "thumbnail-document"];
  const type = `thumbnail-${mimetype.split("/")[0]}`;

  if (!types.includes(type)) {
    return "thumbnail-document";
  }

  return type as "thumbnail-video" | "thumbnail-image" | "thumbnail-document";
};

const downloadThumbnail = async ({
  thumbnailDirectPath: directPath,
  mediaKey,
  mimetype
}: ThumbnailMessage) => {
  if (!directPath || !mediaKey) {
    return null;
  }

  const mediaType = mimetype
    ? normalizeThumbnailMediaType(mimetype)
    : "thumbnail-link";

  const stream = await downloadContentFromMessage(
    { mediaKey, directPath },
    mediaType
  );

  if (!stream) {
    throw new Error("Failed to get stream");
  }

  const buffer = await downloadStream(stream);

  if (!buffer) {
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  const filename = `thumbnail-${makeRandomId(5)}-${new Date().getTime()}.jpg`;

  const media = {
    data: buffer,
    mimetype: "image/jpeg",
    filename
  };
  return media;
};

export const normalizeMediaType = (
  mimetype: string
): "audio" | "video" | "image" | "document" => {
  const types = ["audio", "video", "image", "document"];
  const type = mimetype.split("/")[0];

  if (!types.includes(type)) {
    return "document";
  }

  return type as "audio" | "video" | "image" | "document";
};

const downloadMedia = async (
  msg: proto.IMessage,
  wbot: Session,
  ticket: Ticket,
  fromMe: boolean
) => {
  const message = getMessageMedia(msg);

  if (!message) {
    return null;
  }

  const fileLimit = parseInt(await CheckSettings("downloadLimit", "15"), 10);
  if (
    wbot &&
    message?.fileLength &&
    +message.fileLength > fileLimit * 1024 * 1024
  ) {
    const autoMessage = _t("*Automated message*", ticket);
    const limitMessage = _t("Our system only accepts files up to ", ticket);
    const limitInstructions = _t(
      "We received a file beyond the size limit, If necessary, it can be obtained in the WhatsApp application.",
      ticket
    );
    const fileLimitMessage = {
      text: `${autoMessage}: ${limitMessage} ${fileLimit} MiB`
    };

    if (!ticket.isGroup && !fromMe) {
      const sendMsg = await wbot.sendMessage(
        getJidOf(ticket.contact),
        fileLimitMessage
      );

      sendMsg.message.extendedTextMessage.text = `${autoMessage}: ${limitInstructions}.`;

      // eslint-disable-next-line no-use-before-define
      await verifyMessage(sendMsg, ticket, ticket.contact);
    }
    throw new Error("ERR_FILESIZE_OVER_LIMIT");
  }

  const messageType = msg?.documentMessage
    ? "document"
    : normalizeMediaType(message.mimetype);

  let stream: Transform;
  let contDownload = 0;

  while (contDownload < 10 && !stream) {
    try {
      const tmpMessage = { ...message };
      if (tmpMessage?.directPath) {
        tmpMessage.url = "";
      }

      // eslint-disable-next-line no-await-in-loop
      stream = await downloadContentFromMessage(tmpMessage, messageType);
    } catch (error) {
      contDownload += 1;
      // eslint-disable-next-line no-await-in-loop, no-loop-func
      await new Promise(resolve => {
        setTimeout(resolve, 1000 * contDownload * 2);
      });
      logger.warn({ msg }, `>>>> erro ${contDownload} de baixar o arquivo`);
    }
  }

  if (!stream) {
    throw new Error("Failed to get stream");
  }

  const buffer = await downloadStream(stream);

  if (!buffer) {
    Sentry.setExtra("ERR_WAPP_DOWNLOAD_MEDIA", { msg });
    Sentry.captureException(new Error("ERR_WAPP_DOWNLOAD_MEDIA"));
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  let filename = msg?.documentMessage?.fileName || "";

  if (!filename) {
    const ext = message.mimetype.split("/")[1].split(";")[0];
    filename = `${makeRandomId(5)}-${new Date().getTime()}.${ext}`;
  }

  const media = {
    data: buffer,
    mimetype: message.mimetype,
    filename
  };
  return media;
};

const storeQuotedMessage = async (
  quotedMessage: QuotedMessage,
  ticket: Ticket,
  wbot: Session
): Promise<Message> => {
  const { quotedId, quotedMsg, participant } = quotedMessage;

  if (!quotedMsg || !quotedId || !participant) return null;

  if (!wbot) {
    wbot = await GetTicketWbot(ticket);
  }

  const body = getBodyMessage(quotedMsg) || "";
  const fromMe = !!wbot.myJid && participant === wbot.myJid;

  const messageMedia = getMessageMedia(quotedMsg);

  const thumbnailMsg =
    messageMedia && keys(messageMedia).includes("thumbnailDirectPath")
      ? messageMedia
      : null;
  const thumbnailMedia =
    thumbnailMsg && (await downloadThumbnail(thumbnailMsg));
  const media =
    messageMedia && (await downloadMedia(quotedMsg, wbot, ticket, fromMe));

  let mediaUrl = null;
  if (media) {
    // eslint-disable-next-line no-use-before-define
    mediaUrl = await saveMediaToFile(media, ticket);
  }

  let thumbnailUrl = null;
  if (thumbnailMedia) {
    // eslint-disable-next-line no-use-before-define
    thumbnailUrl = await saveMediaToFile(thumbnailMedia, ticket);
  }

  const mediaType = media?.mimetype.split("/")[0];

  const messageData = {
    id: `${quotedId}-${ticket.id}`,
    ticketId: ticket.id,
    body,
    fromMe,
    mediaType,
    mediaUrl,
    thumbnailUrl,
    read: true,
    dataJson: JSON.stringify(quotedMsg)
  };

  return CreateMessageService({
    messageData,
    companyId: ticket.companyId
  });
};

const verifyQuotedMessage = async (
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  wbot?: Session
): Promise<Message | null> => {
  if (!msg) return null;
  const quotedMessage = getQuotedMessage(msg);
  const { quotedId } = quotedMessage;

  if (!quotedId) return null;

  const quotedTicketId = `${quotedId}-${ticket.id}`;

  // find message for any of quotedId and quotedTicketId
  const dbQuotedMsg = await Message.findOne({
    where: {
      id: {
        [Op.or]: [quotedId, quotedTicketId]
      },
      ticketId: ticket?.id
    }
  });

  if (!dbQuotedMsg) {
    return storeQuotedMessage(quotedMessage, ticket, wbot);
  }

  return dbQuotedMsg;
};

/**
 * @description: call UpdateTicketService to update ticket status, if ticketData have a queue id it will not run the chatbot
 * @params {Ticket} ticket - ticket to be updated
 * @params {UpdateTicketData} ticketData - data to be updated
 * @returns {Promise<Ticket>} - updated ticket
 */
async function updateTicket(
  ticket: Ticket,
  ticketData: UpdateTicketData
): Promise<Ticket> {
  await UpdateTicketService({
    ticketData,
    ticketId: ticket.id,
    companyId: ticket.companyId,
    dontRunChatbot: !!ticketData.queueId
  });
  await ticket.reload();
  return ticket;
}

type VerifyMessageOptions = {
  userId?: number;
  skipWebsocket?: boolean;
};

type VerifyMediaMessageOptions = VerifyMessageOptions & {
  messageMedia?: WAGenericMediaMessage | null;
  mediaInfo?: MediaInfo | null;
  wbot?: Session | null;
};

export const verifyMediaMessage = async (
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  contact: Contact,
  {
    wbot,
    messageMedia,
    userId,
    mediaInfo,
    skipWebsocket
  }: VerifyMediaMessageOptions = {}
): Promise<Message> => {
  const io = getIO();
  const quotedMsg = await verifyQuotedMessage(msg, ticket, wbot);

  const thumbnailMsg = messageMedia || msg?.message?.extendedTextMessage;
  const thumbnailMedia =
    thumbnailMsg && (await downloadThumbnail(thumbnailMsg));
  const media =
    !mediaInfo &&
    (await downloadMedia(
      getUnpackedMessage(msg),
      wbot,
      ticket,
      msg.key?.fromMe
    ));

  if (!mediaInfo && !media && !thumbnailMedia) {
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  let mediaUrl = mediaInfo?.mediaUrl || null;
  if (media) {
    mediaUrl = await saveMediaToFile(media, ticket);
  }

  let thumbnailUrl = null;
  if (thumbnailMedia) {
    thumbnailUrl = await saveMediaToFile(thumbnailMedia, ticket);
  }

  const mimetype = mediaInfo?.mimetype || media?.mimetype || "";
  const mediaType = mimetype.split("/")[0];
  const filename = mediaInfo?.filename || media?.filename || "file.bin";

  let body = getBodyMessage(msg?.message);

  if (
    mediaType === "audio" &&
    (await GetCompanySetting(
      ticket.companyId,
      "audioTranscriptions",
      "disabled"
    )) === "enabled"
  ) {
    const apiKey = await GetCompanySetting(ticket.companyId, "openAiKey", null);
    const provider = await GetCompanySetting(
      ticket.companyId,
      "aiProvider",
      "openai"
    );

    if (apiKey) {
      const audioTranscription = await transcriber(
        mediaUrl.startsWith("http")
          ? mediaUrl
          : `${getPublicPath()}/${mediaUrl}`,
        { apiKey, provider },
        filename
      );
      if (audioTranscription) {
        body = audioTranscription;
      }
    }
  }

  const messageData = {
    id: msg.key.id,
    ticketId: ticket.id,
    userId,
    contactId: msg.key.fromMe ? undefined : contact.id,
    body: body || "",
    fromMe: msg.key.fromMe,
    read: msg.key.fromMe,
    mediaUrl,
    mediaType,
    thumbnailUrl,
    quotedMsgId: quotedMsg?.id,
    ack: msg.status || 0,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant,
    dataJson: JSON.stringify(msg)
  };

  await ticket.update({
    lastMessage: body || filename ? `📎 ${filename}` : ""
  });

  const newMessage = await CreateMessageService({
    messageData,
    companyId: ticket.companyId,
    skipWebsocket
  });

  if (!msg.key.fromMe && ticket.status === "closed") {
    await updateTicket(ticket, { status: "pending" });
    await ticket.reload({
      include: [
        { model: Queue, as: "queue" },
        { model: User, as: "user" },
        { model: Contact, as: "contact" }
      ]
    });

    io.to(`company-${ticket.companyId}-closed`)
      .to(`queue-${ticket.queueId}-closed`)
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "delete",
        ticket,
        ticketId: ticket.id
      });

    io.to(`company-${ticket.companyId}-${ticket.status}`)
      .to(`queue-${ticket.queueId}-${ticket.status}`)
      .to(ticket.id.toString())
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "update",
        ticket,
        ticketId: ticket.id
      });
  }

  return newMessage;
};

export const verifyMessage = async (
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  contact: Contact,
  { userId, skipWebsocket }: VerifyMessageOptions = {}
) => {
  const io = getIO();
  const quotedMsg = await verifyQuotedMessage(msg, ticket);
  const body = getBodyMessage(msg?.message);

  const messageData = {
    id: msg.key.id,
    ticketId: ticket.id,
    userId,
    contactId: msg.key.fromMe ? undefined : contact.id,
    body,
    fromMe: msg.key.fromMe,
    mediaType: msg.message.reactionMessage ? "reactionMessage" : null,
    read: msg.key.fromMe,
    quotedMsgId: quotedMsg?.id,
    ack: msg.status || 0,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant,
    dataJson: JSON.stringify(msg),
    isEdited: false
  };

  await ticket.update({
    lastMessage: body.substring(0, 255).replace(/\n/g, " ")
  });

  const newMessage = await CreateMessageService({
    messageData,
    companyId: ticket.companyId,
    skipWebsocket
  });

  if (!msg.key.fromMe && ticket.status === "closed") {
    await updateTicket(ticket, { status: "pending" });
    await ticket.reload({
      include: [
        { model: Queue, as: "queue" },
        { model: User, as: "user" },
        { model: Contact, as: "contact" }
      ]
    });

    io.to(`company-${ticket.companyId}-closed`)
      .to(`queue-${ticket.queueId}-closed`)
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "delete",
        ticket,
        ticketId: ticket.id
      });

    io.to(`company-${ticket.companyId}-${ticket.status}`)
      .to(`queue-${ticket.queueId}-${ticket.status}`)
      .to(ticket.id.toString())
      .emit(`company-${ticket.companyId}-ticket`, {
        action: "update",
        ticket,
        ticketId: ticket.id
      });
  }

  return newMessage;
};

export const verifyEditedMessage = async (
  msg: proto.IMessage,
  ticket: Ticket,
  msgId: string
) => {
  const editedText =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage.caption ||
    msg.documentWithCaptionMessage?.message.documentMessage.caption;

  if (!editedText) return;

  const editedMsg = await Message.findByPk(msgId);
  const messageData = {
    id: editedMsg.id,
    ticketId: editedMsg.ticketId,
    contactId: editedMsg.contactId,
    body: editedText,
    fromMe: editedMsg.fromMe,
    mediaType: editedMsg.mediaType,
    read: editedMsg.read,
    quotedMsgId: editedMsg.quotedMsgId,
    ack: editedMsg.ack,
    remoteJid: editedMsg.remoteJid,
    participant: editedMsg.participant,
    dataJson: editedMsg.dataJson,
    isEdited: true
  };

  const oldMessage = {
    messageId: messageData.id,
    body: editedMsg.body,
    ticketId: editedMsg.ticketId
  };

  await OldMessage.upsert(oldMessage);

  await ticket.update({
    lastMessage: messageData.body
  });

  await CreateMessageService({ messageData, companyId: ticket.companyId });

  const io = getIO();

  io.to(ticket.status)
    .to(ticket.id.toString())
    .emit(`company-${ticket.companyId}-ticket`, {
      action: "update",
      ticket,
      ticketId: ticket.id
    });
};

export const verifyDeleteMessage = async (
  msg: proto.Message.IProtocolMessage,
  ticket: Ticket
) => {
  const message = await Message.findByPk(msg.key.id, {
    include: [
      "contact",
      {
        model: Ticket,
        include: [
          {
            model: Contact
          }
        ]
      }
    ]
  });

  if (!message) {
    return;
  }

  await message.update({
    isDeleted: true
  });

  const io = getIO();
  io.to(message.ticketId.toString())
    .to(message.ticket.status)
    .to("notification")
    .emit(`company-${ticket.companyId}-appMessage`, {
      action: "create",
      message,
      ticket: message.ticket,
      contact: message.ticket.contact
    });
};

const quickMessage = async (
  wbot: Session,
  ticket: Ticket,
  text: string,
  saveOnTicket = false
) => {
  const debouncedSentMessage = debounce(
    async () => {
      const sentMessage = await wbot.sendMessage(getJidOf(ticket.contact), {
        text: `\u200e${text}`
      });
      if (saveOnTicket) {
        verifyMessage(sentMessage, ticket, ticket.contact);
      }
    },
    1000,
    ticket.id
  );
  debouncedSentMessage();
};

const isValidMsg = (msg: proto.IWebMessageInfo): boolean => {
  if (msg.key.remoteJid === "status@broadcast") return false;
  try {
    const msgType = getTypeMessage(msg);
    if (!msgType) {
      return false;
    }

    const ifType =
      msgType === "conversation" ||
      msgType === "editedMessage" ||
      msgType === "extendedTextMessage" ||
      msgType === "audioMessage" ||
      msgType === "videoMessage" ||
      msgType === "imageMessage" ||
      msgType === "documentMessage" ||
      msgType === "documentWithCaptionMessage" ||
      msgType === "stickerMessage" ||
      msgType === "buttonsResponseMessage" ||
      msgType === "buttonsMessage" ||
      msgType === "messageContextInfo" ||
      msgType === "locationMessage" ||
      msgType === "liveLocationMessage" ||
      msgType === "contactMessage" ||
      msgType === "voiceMessage" ||
      msgType === "mediaMessage" ||
      msgType === "contactsArrayMessage" ||
      msgType === "reactionMessage" ||
      msgType === "ephemeralMessage" ||
      msgType === "protocolMessage" ||
      msgType === "listResponseMessage" ||
      msgType === "listMessage" ||
      msgType === "templateMessage" ||
      msgType === "viewOnceMessage" ||
      msgType === "viewOnceMessageV2";

    if (!ifType) {
      logger.warn(`#### Nao achou o type em isValidMsg: ${msgType}
${JSON.stringify(msg?.message)}`);
      Sentry.setExtra("Mensagem", { BodyMsg: msg.message, msg, msgType });
      Sentry.captureException(new Error("Novo Tipo de Mensagem em isValidMsg"));
    }

    return !!ifType;
  } catch (error) {
    Sentry.setExtra("Error isValidMsg", { msg });
    Sentry.captureException(error);
    return false;
  }
};

const emojiNumberOption = (number: number): string => {
  const numEmojis = [
    "0️⃣",
    "1️⃣",
    "2️⃣",
    "3️⃣",
    "4️⃣",
    "5️⃣",
    "6️⃣",
    "7️⃣",
    "8️⃣",
    "9️⃣",
    "🔟"
  ];

  return number <= 10 ? numEmojis[number] : `[ ${number} ]`;
};

const sendMenu = async (
  wbot: Session,
  ticket: Ticket,
  currentOption: Queue | QueueOption,
  sendBackToMain = true
) => {
  const message =
    currentOption instanceof Queue
      ? (currentOption as Queue).greetingMessage
      : (currentOption as QueueOption).message;

  const botText = async () => {
    const showNumericIcons =
      currentOption.options.length <= 10 &&
      (await GetCompanySetting(
        ticket.companyId,
        "showNumericIcons",
        "disabled"
      )) === "enabled";

    let options = "";

    currentOption.options.forEach(option => {
      options += showNumericIcons
        ? `${emojiNumberOption(Number(option.option))} - `
        : `*[ ${option.option} ]* - `;
      options += `${option.title}\n`;
    });

    if (sendBackToMain) {
      options += `\n${showNumericIcons ? "#️⃣" : "[ # ]"} - ${_t(
        "Back to Main Menu",
        ticket
      )}`;
    }

    const textMessage = {
      text: formatBody(`${message}\n\n${options}`, ticket)
    };

    const sendMsg = await wbot.sendMessage(getJidOf(ticket), textMessage);

    await verifyMessage(sendMsg, ticket, ticket.contact);
  };

  botText();
};

export const startQueue = async (
  wbot: Session,
  ticket: Ticket,
  queue: Queue = null,
  sendBackToMain = true
) => {
  if (!queue) {
    queue = await Queue.findByPk(ticket.queueId, {
      include: [
        {
          model: QueueOption,
          as: "options",
          where: { parentId: null },
          required: false
        }
      ],
      order: [["options", "option", "ASC"]]
    });
  }

  const { companyId, contact } = ticket;
  let chatbot = false;

  if (queue?.options) {
    chatbot = queue.options.length > 0;
  }
  await UpdateTicketService({
    ticketData: { queueId: queue.id, chatbot, status: "pending" },
    ticketId: ticket.id,
    companyId: ticket.companyId,
    dontRunChatbot: true
  });

  // do not process queue if company is not compliant with payments
  if (!(await checkCompanyCompliant(companyId))) {
    return;
  }

  let filePath = null;
  let optionsMsg = null;

  if (queue.mediaPath !== null && queue.mediaPath !== "") {
    filePath = path.resolve("public", queue.mediaPath);
    optionsMsg = await getMessageFileOptions(queue.mediaName, filePath);
  }

  /* Tratamento para envio de mensagem quando a fila está fora do expediente */
  let currentSchedule: ScheduleResult;

  const scheduleType = await GetCompanySetting(
    companyId,
    "scheduleType",
    "disabled"
  );

  if (scheduleType === "queue") {
    currentSchedule = await VerifyCurrentSchedule(ticket.companyId, queue.id);

    if (
      !isNil(currentSchedule) &&
      (!currentSchedule || currentSchedule.inActivity === false)
    ) {
      outOfHoursCache.set(`ticket-${ticket.id}`, true);
      const outOfHoursMessage =
        queue.outOfHoursMessage?.trim() ||
        "Estamos fora do horário de expediente";
      const sentMessage = await wbot.sendMessage(getJidOf(ticket), {
        text: formatBody(outOfHoursMessage, ticket)
      });
      await verifyMessage(sentMessage, ticket, contact);
      const outOfHoursAction = await GetCompanySetting(
        companyId,
        "outOfHoursAction",
        "pending"
      );
      await UpdateTicketService({
        ticketData: {
          queueId: queue.id,
          chatbot: false,
          status: outOfHoursAction
        },
        ticketId: ticket.id,
        companyId: ticket.companyId
      });
      return;
    }
  }

  if (queue.options.length === 0) {
    if (queue.greetingMessage?.trim()) {
      const body = formatBody(`${queue.greetingMessage.trim()}`, ticket);

      if (filePath) {
        optionsMsg.caption = body;
      } else {
        const sentMessage = await wbot.sendMessage(getJidOf(ticket), {
          text: body
        });
        await verifyMessage(sentMessage, ticket, contact);
        return;
      }
    }

    if (filePath) {
      const sentMediaMessage = await wbot.sendMessage(getJidOf(ticket), {
        ...optionsMsg
      });
      await verifyMediaMessage(sentMediaMessage, ticket, contact);
    }
  } else {
    if (filePath) {
      const sentMediaMessage = await wbot.sendMessage(getJidOf(ticket), {
        ...optionsMsg
      });
      await verifyMediaMessage(sentMediaMessage, ticket, contact);
    }
    sendMenu(wbot, ticket, queue, sendBackToMain);
  }
};

const verifyQueue = async (
  wbot: Session,
  msg: proto.IWebMessageInfo | null,
  ticket: Ticket,
  _contact: Contact
) => {
  const whatsapp = await ShowWhatsAppService(wbot.id!);

  if (!whatsapp) {
    throw new Error("ERR_NO_WAPP_FOUND");
  }

  const { queues, greetingMessage } = whatsapp;

  if (queues.length === 1) {
    await startQueue(wbot, ticket, head(queues), false);
    return;
  }

  const showNumericIcons =
    queues.length <= 10 &&
    (await GetCompanySetting(
      ticket.companyId,
      "showNumericIcons",
      "disabled"
    )) === "enabled";

  const selectedOption = msg ? getBodyMessage(msg?.message) : null;
  const choosenQueue = selectedOption ? queues[+selectedOption - 1] : null;

  const botText = async () => {
    let options = "";

    queues.forEach((queue, index) => {
      options += showNumericIcons
        ? `${emojiNumberOption(index + 1)} - `
        : `*[ ${index + 1} ]* - `;
      options += `${queue.name}\n`;
    });

    const textMessage = {
      text: formatBody(`${greetingMessage}\n\n${options}`, ticket)
    };

    const sendMsg = await wbot.sendMessage(getJidOf(ticket), textMessage);

    await verifyMessage(sendMsg, ticket, ticket.contact);
  };

  if (choosenQueue) {
    await startQueue(wbot, ticket, choosenQueue);
  } else {
    botText();
    await updateTicket(ticket, {
      chatbot: true
    });
  }
};

const handleRating = async (
  rate: number,
  ticket: Ticket,
  ticketTraking: TicketTraking,
  wbot: Session
) => {
  const whatsapp = await ShowWhatsAppService(ticket.whatsappId);

  if (!whatsapp) {
    throw new Error("ERR_NO_WAPP_FOUND");
  }

  let finalRate = rate;

  if (rate < 1) {
    finalRate = 1;
  }
  if (rate > 5) {
    finalRate = 5;
  }

  await UserRating.create({
    ticketId: ticketTraking.ticketId,
    companyId: ticketTraking.companyId,
    userId: ticketTraking.userId,
    rate: finalRate
  });

  const complationMessage =
    whatsapp.complationMessage.trim() || _t("Service completed", ticket);

  const text = formatBody(`\u200e${complationMessage}`, ticket);

  wbot
    .sendMessage(getJidOf(ticket), {
      text
    })
    .then(
      () => {
        ticketTraking.update({
          rated: true
        });
      },
      e => logger.error({ e }, "error sending message")
    );
};

const handleChartbot = async (
  ticket: Ticket,
  msg: WAMessage,
  wbot: Session,
  dontReadTheFirstQuestion = false
) => {
  const queue = await Queue.findByPk(ticket.queueId, {
    include: [
      {
        model: QueueOption,
        as: "options",
        where: { parentId: null }
      }
    ],
    order: [["options", "option", "ASC"]]
  });

  const messageBody = getBodyMessage(msg?.message);

  if (messageBody === "#") {
    // voltar para o menu inicial
    await updateTicket(ticket, {
      queueOptionId: null,
      chatbot: false,
      queueId: null
    });
    await verifyQueue(wbot, msg, ticket, ticket.contact);
    return;
  }

  // voltar para o menu anterior
  if (!isNil(queue) && !isNil(ticket.queueOptionId) && messageBody === "#") {
    const option = await QueueOption.findByPk(ticket.queueOptionId);
    await ticket.update({ queueOptionId: option?.parentId });

    // escolheu uma opção
  } else if (!isNil(queue) && !isNil(ticket.queueOptionId)) {
    const count = await QueueOption.count({
      where: { parentId: ticket.queueOptionId }
    });
    let option: QueueOption = null;
    if (count === 1) {
      option = await QueueOption.findOne({
        where: { parentId: ticket.queueOptionId }
      });
    } else {
      option = await QueueOption.findOne({
        where: {
          option: messageBody || "",
          parentId: ticket.queueOptionId
        }
      });
    }
    if (option) {
      await ticket.update({ queueOptionId: option?.id });
      // if (option.mediaPath !== null && option.mediaPath !== "")  {

      //   const filePath = path.resolve("public", option.mediaPath);

      //   const optionsMsg = await getMessageOptions(option.mediaName, filePath);

      //   let sentMessage = await wbot.sendMessage(`${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`, { ...optionsMsg });

      //   await verifyMediaMessage(sentMessage, ticket, ticket.contact);
      // }
    }

    // não linha a primeira pergunta
  } else if (
    !isNil(queue) &&
    isNil(ticket.queueOptionId) &&
    !dontReadTheFirstQuestion
  ) {
    const option = queue?.options.find(o => o.option === messageBody);
    if (option) {
      await ticket.update({ queueOptionId: option?.id });
    } else if (
      (await GetCompanySetting(
        ticket.companyId,
        "chatbotAutoExit",
        "disabled"
      )) === "enabled"
    ) {
      // message didn't identified an option and company setting to exit chatbot
      await updateTicket(ticket, { chatbot: false });
      const whatsapp = await Whatsapp.findByPk(ticket.whatsappId);
      if (whatsapp.transferMessage) {
        const body = formatBody(`${whatsapp.transferMessage}`, ticket);
        await SendWhatsAppMessage({ body, ticket });
      }
    } else {
      await sendMenu(wbot, ticket, queue);
    }
  }

  await ticket.reload();

  /* * /
  if (!isNil(queue) && isNil(ticket.queueOptionId)) {
    sendMenu(wbot, ticket, queue);
  } else /* */ if (!isNil(queue) && !isNil(ticket.queueOptionId)) {
    const currentOption = await QueueOption.findByPk(ticket.queueOptionId, {
      include: [
        {
          model: Queue,
          as: "forwardQueue",
          include: [
            {
              model: QueueOption,
              as: "options",
              where: { parentId: null },
              required: false
            }
          ]
        },
        {
          model: QueueOption,
          as: "options",
          required: false
        }
      ],
      order: [
        [
          Sequelize.cast(
            Sequelize.col("forwardQueue.options.option"),
            "INTEGER"
          ),
          "ASC"
        ],
        [Sequelize.cast(Sequelize.col("options.option"), "INTEGER"), "ASC"]
      ]
    });

    let filePath = null;
    let optionsMsg = null;
    if (currentOption.mediaPath !== null && currentOption.mediaPath !== "") {
      filePath = path.resolve("public", currentOption.mediaPath);
      optionsMsg = await getMessageFileOptions(
        currentOption.mediaName,
        filePath
      );
    }

    if (currentOption.exitChatbot || currentOption.forwardQueueId) {
      const text = formatBody(`${currentOption.message.trim()}`, ticket);

      if (filePath) {
        optionsMsg.caption = text || undefined;
        const sentMessage = await wbot.sendMessage(getJidOf(ticket), {
          ...optionsMsg
        });
        await verifyMediaMessage(sentMessage, ticket, ticket.contact);
      } else if (text) {
        const sendMsg = await wbot.sendMessage(getJidOf(ticket), { text });
        await verifyMessage(sendMsg, ticket, ticket.contact);
      }

      if (currentOption.exitChatbot) {
        await updateTicket(ticket, {
          chatbot: false,
          queueOptionId: null
        });
      } else if (currentOption.forwardQueueId) {
        await updateTicket(ticket, {
          queueOptionId: null,
          chatbot: false,
          queueId: currentOption.forwardQueueId
        });
        startQueue(wbot, ticket, currentOption.forwardQueue);
      }
      return;
    }

    if (filePath) {
      const sentMessage = await wbot.sendMessage(getJidOf(ticket), {
        ...optionsMsg
      });
      await verifyMediaMessage(sentMessage, ticket, ticket.contact);
    }

    if (currentOption.options.length > -1) {
      sendMenu(wbot, ticket, currentOption);
    }
  }
};

const handleMessage = async (
  msg: proto.IWebMessageInfo,
  wbot: Session,
  companyId: number,
  queueId?: number
): Promise<void> => {
  if (!isValidMsg(msg)) return;

  if (msg.message?.ephemeralMessage) {
    msg.message = msg.message.ephemeralMessage.message;
  }

  try {
    let msgContact: IMe;
    let groupContact: Contact | undefined;

    const isGroup = msg.key.remoteJid?.endsWith("@g.us");

    if (isGroup) {
      const msgIsGroupBlock = await Setting.findOne({
        where: {
          companyId,
          key: "CheckMsgIsGroup"
        }
      });

      if (!msgIsGroupBlock || msgIsGroupBlock.value === "enabled") {
        return;
      }
    }

    const bodyMessage = getBodyMessage(msg?.message);
    const msgType = getTypeMessage(msg);

    const unpackedMessage =
      msgType !== "templateMessage" && getUnpackedMessage(msg);
    const messageMedia = unpackedMessage && getMessageMedia(unpackedMessage);
    if (msg.key.fromMe) {
      if (bodyMessage?.startsWith("\u200e")) return;

      if (
        !messageMedia &&
        msgType !== "conversation" &&
        msgType !== "extendedTextMessage" &&
        msgType !== "vcard"
      )
        return;
      msgContact = await getContactMessage(msg, wbot);
    } else {
      msgContact = await getContactMessage(msg, wbot);
    }

    if (isGroup) {
      groupContact = await wbotMutex.runExclusive(async () => {
        let result = groupContactCache.get(msg.key.remoteJid);
        if (!result) {
          const groupMetadata = await wbot.groupMetadata(msg.key.remoteJid);
          const msgGroupContact = {
            id: groupMetadata.id,
            name: groupMetadata.subject
          };
          result = await verifyContact(msgGroupContact, wbot, companyId);
          groupContactCache.set(msg.key.remoteJid, result);
        }
        return result;
      });
    }

    const whatsapp = await ShowWhatsAppService(wbot.id!);

    if (!whatsapp) {
      throw new Error("ERR_NO_WAPP_FOUND");
    }

    const contact = await verifyContact(msgContact, wbot, companyId);

    if (!msg.key.fromMe && !contact.isGroup) {
      const userRatingEnabled =
        (await GetCompanySetting(companyId, "userRating", "")) === "enabled";

      const ticketTracking =
        userRatingEnabled &&
        (await TicketTraking.findOne({
          where: {
            whatsappId: whatsapp.id,
            rated: false,
            expired: false,
            ratingAt: { [Op.not]: null }
          },
          include: [
            {
              model: Ticket,
              where: {
                status: "closed",
                contactId: contact.id
              },
              include: [
                {
                  model: Contact
                },
                {
                  model: User
                },
                {
                  model: Queue
                }
              ]
            }
          ]
        }));

      if (ticketTracking) {
        try {
          /**
           * Tratamento para avaliação do atendente
           */

          logger.debug(
            { ticketTracking },
            `start handling tracking rating for ticket ${ticketTracking.ticketId}`
          );

          const rate = Number(bodyMessage);

          if (Number.isFinite(rate)) {
            logger.debug(
              `received rate ${rate} for ticket ${ticketTracking.ticketId}`
            );
            handleRating(rate, ticketTracking.ticket, ticketTracking, wbot);
            return;
          }
          if (bodyMessage.trim() === "!") {
            // abort rating and reopen ticket
            logger.debug(
              `ticket ${ticketTracking.ticketId} reopen by contact request`
            );
            ticketTracking.update({
              ratingAt: null
            });
            updateTicket(ticketTracking.ticket, {
              status: "open",
              userId: ticketTracking.userId
            });
            quickMessage(
              wbot,
              ticketTracking.ticket,
              _t("Service reopened", ticketTracking.ticket),
              true
            );
            return;
          }
          // expire rating
          logger.debug(
            `tracking of ticket ${ticketTracking.ticketId} expired by wrong rate ${bodyMessage}`
          );
          ticketTracking.update({
            expired: true
          });
          quickMessage(
            wbot,
            ticketTracking.ticket,
            _t("Rating Cancelled", ticketTracking.ticket)
          );
          if (bodyMessage.length < 10) {
            // short message just stop the processing
            return;
          }
        } catch (e) {
          Sentry.captureException(e);
          console.log(e);
        }
      }
    }

    const scheduleType = await GetCompanySetting(
      companyId,
      "scheduleType",
      "disabled"
    );

    const outOfHoursAction = await GetCompanySetting(
      companyId,
      "outOfHoursAction",
      "pending"
    );
    let currentSchedule: ScheduleResult = null;

    if (scheduleType === "company") {
      currentSchedule = await VerifyCurrentSchedule(companyId);
    }

    let defaultQueue: Queue;

    if (
      (msg.key.fromMe ||
        contact.disableBot ||
        currentSchedule?.inActivity === false) &&
      !contact.isGroup &&
      whatsapp.queues.length === 1
    ) {
      defaultQueue = await Queue.findByPk(whatsapp.queues[0].id);
    }

    const findOnly = [
      "reactionMessage",
      "stickerMessage",
      "editedMessage",
      "protocolMessage"
    ].includes(msgType);

    const { ticket, justCreated } = await FindOrCreateTicketService(
      contact,
      wbot.id!,
      companyId,
      {
        groupContact,
        incrementUnread: !msg.key.fromMe,
        findOnly,
        queue: queueId
          ? (await Queue.findByPk(queueId)) || defaultQueue
          : defaultQueue
      }
    );

    if (!ticket) {
      return;
    }

    // voltar para o menu inicial

    if (bodyMessage === "#" && !isGroup) {
      await updateTicket(ticket, {
        queueOptionId: null,
        chatbot: false,
        queueId: null
      });
      await verifyQueue(wbot, msg, ticket, ticket.contact);
      return;
    }

    let newMessage: Message;

    if (
      messageMedia ||
      msg?.message?.extendedTextMessage?.thumbnailDirectPath
    ) {
      newMessage = await verifyMediaMessage(msg, ticket, contact, {
        wbot,
        messageMedia,
        skipWebsocket: justCreated
      });
    } else if (
      msg.message?.editedMessage?.message?.protocolMessage?.editedMessage
    ) {
      // message edited by Whatsapp App
      await verifyEditedMessage(
        msg.message.editedMessage.message.protocolMessage.editedMessage,
        ticket,
        msg.message.editedMessage.message.protocolMessage.key.id
      );
    } else if (msg.message?.protocolMessage?.editedMessage) {
      // message edited by Whatsapp Web
      await verifyEditedMessage(
        msg.message.protocolMessage.editedMessage,
        ticket,
        msg.message.protocolMessage.key.id
      );
    } else if (msg.message?.protocolMessage?.type === 0) {
      await verifyDeleteMessage(msg.message.protocolMessage, ticket);
    } else {
      newMessage = await verifyMessage(msg, ticket, contact, {
        skipWebsocket: justCreated
      });
    }

    if (isGroup || contact.disableBot) {
      if (justCreated && newMessage) {
        websocketCreateMessage(newMessage);
      }
      return;
    }

    try {
      if (!msg.key.fromMe && scheduleType) {
        const isOpenOnline =
          ticket.status === "open" && ticket.user.socketSessions.length > 0;

        const avoidResend =
          !isOpenOnline && outOfHoursCache.get(`ticket-${ticket.id}`);

        if (scheduleType === "company" && !isOpenOnline) {
          if (
            !isNil(currentSchedule) &&
            (!currentSchedule || currentSchedule.inActivity === false)
          ) {
            if (!avoidResend) {
              outOfHoursCache.set(`ticket-${ticket.id}`, true);
              const outOfHoursMessage =
                whatsapp.outOfHoursMessage.trim() ||
                _t("We are out of office hours right now", ticket);
              const sentMessage = await wbot.sendMessage(getJidOf(ticket), {
                text: formatBody(outOfHoursMessage, ticket)
              });
              await verifyMessage(sentMessage, ticket, ticket.contact);
            }
            if (ticket.status !== "open") {
              await UpdateTicketService({
                ticketData: { chatbot: false, status: outOfHoursAction },
                ticketId: ticket.id,
                companyId: ticket.companyId
              });
            }
            return;
          }
        }

        if (
          scheduleType === "queue" &&
          ticket.queueId !== null &&
          !isOpenOnline
        ) {
          currentSchedule = await VerifyCurrentSchedule(
            companyId,
            ticket.queueId
          );
          const queue = await Queue.findByPk(ticket.queueId);

          if (
            !isNil(currentSchedule) &&
            (!currentSchedule || currentSchedule.inActivity === false)
          ) {
            if (!avoidResend) {
              outOfHoursCache.set(`ticket-${ticket.id}`, true);
              const outOfHoursMessage =
                queue.outOfHoursMessage?.trim() ||
                _t("We are out of office hours right now", ticket);
              const sentMessage = await wbot.sendMessage(getJidOf(ticket), {
                text: formatBody(outOfHoursMessage, ticket)
              });
              await verifyMessage(sentMessage, ticket, ticket.contact);
            }
            if (ticket.status !== "open") {
              await UpdateTicketService({
                ticketData: { chatbot: false, status: outOfHoursAction },
                ticketId: ticket.id,
                companyId: ticket.companyId
              });
            }
            return;
          }
        }
      }
    } catch (e) {
      Sentry.captureException(e);
      console.log(e);
    }

    if (
      !ticket.queue &&
      !isGroup &&
      !msg.key.fromMe &&
      !ticket.userId &&
      whatsapp.queues.length >= 1
    ) {
      await verifyQueue(wbot, msg, ticket, ticket.contact);
    }

    if (justCreated && newMessage) {
      await newMessage.reload();
      websocketCreateMessage(newMessage);
    }

    const dontReadTheFirstQuestion = ticket.queue === null;

    await ticket.reload();

    if (
      justCreated &&
      !whatsapp?.queues?.length &&
      !ticket.userId &&
      !isGroup &&
      !msg.key.fromMe
    ) {
      const message = await Message.findOne({
        where: {
          ticketId: ticket.id,
          fromMe: true
        },
        order: [["createdAt", "DESC"]]
      });

      if (message && message.body.includes(whatsapp.greetingMessage)) {
        return;
      }

      if (whatsapp.greetingMessage) {
        const debouncedSentMessage = debounce(
          async () => {
            await wbot.sendMessage(getJidOf(ticket), {
              text: formatBody(`${whatsapp.greetingMessage}`, ticket)
            });
          },
          1000,
          ticket.id
        );
        debouncedSentMessage();
        return;
      }
    }

    if (ticket.queue && ticket.chatbot && !msg.key.fromMe) {
      await handleChartbot(ticket, msg, wbot, dontReadTheFirstQuestion);
    }
  } catch (err) {
    console.log(err);
    Sentry.captureException(err);
    logger.error(`Error handling whatsapp message: Err: ${err}`);
  }
};

const handleMsgAck = async (msg: WAMessage, ack: number) => {
  if (!ack) return;

  const io = getIO();

  try {
    const messageToUpdate = await Message.findByPk(msg.key.id, {
      include: [
        "contact",
        {
          model: Message,
          as: "quotedMsg",
          include: ["contact"]
        }
      ]
    });

    if (!messageToUpdate || ack <= messageToUpdate.ack) return;

    await messageToUpdate.update({ ack });
    io.to(messageToUpdate.ticketId.toString()).emit(
      `company-${messageToUpdate.companyId}-appMessage`,
      {
        action: "update",
        message: messageToUpdate
      }
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`Error handling message ack. Err: ${err}`);
  }
};

const verifyRecentCampaign = async (
  message: proto.IWebMessageInfo,
  companyId: number
) => {
  if (!message.key.fromMe) {
    const number = message.key.remoteJid.replace(/\D/g, "");
    const campaigns = await Campaign.findAll({
      where: { companyId, status: "EM_ANDAMENTO", confirmation: true }
    });
    if (campaigns) {
      const ids = campaigns.map(c => c.id);
      const campaignShipping = await CampaignShipping.findOne({
        where: { campaignId: { [Op.in]: ids }, number, confirmation: null }
      });

      if (campaignShipping) {
        await campaignShipping.update({
          confirmedAt: moment(),
          confirmation: true
        });
        await campaignQueue.add(
          "DispatchConfirmedCampaign",
          {
            campaignShippingId: campaignShipping.id,
            campaignId: campaignShipping.campaignId
          },
          {
            delay: parseToMilliseconds(randomValue(0, 10))
          }
        );
        return true;
      }
    }
  }
  return false;
};

const filterMessages = (msg: WAMessage): boolean => {
  // receiving edited message
  if (msg.message?.protocolMessage?.editedMessage) return true;
  // receiving message deletion info
  if (msg.message?.protocolMessage?.type === 0) return true;
  // ignore other protocolMessages
  if (msg.message?.protocolMessage) return false;

  if (
    [
      WAMessageStubType.REVOKE,
      WAMessageStubType.E2E_DEVICE_CHANGED,
      WAMessageStubType.E2E_IDENTITY_CHANGED,
      WAMessageStubType.CIPHERTEXT
    ].includes(msg.messageStubType)
  )
    return false;

  return true;
};

const wbotMessageListener = async (
  wbot: Session,
  companyId: number
): Promise<void> => {
  try {
    wbot.ev.on("messages.upsert", async (messageUpsert: ImessageUpsert) => {
      logger.trace({ messageUpsert }, "wbotMessageListener: messages.upsert");
      const messages = messageUpsert.messages
        .filter(filterMessages)
        .map(msg => msg);

      if (!messages) return;

      messages.forEach(async (message: proto.IWebMessageInfo) => {
        if (!message?.message) {
          logger.warn(
            { message },
            "wbotMessageListener: messages.upsert without supported content"
          );
          return;
        }

        await wbot.sendReceipts([message.key], undefined);

        if (await verifyRecentCampaign(message, companyId)) {
          return;
        }
        await handleMessage(message, wbot, companyId);
      });
    });

    wbot.ev.on("messages.update", (messageUpdate: WAMessageUpdate[]) => {
      logger.trace({ messageUpdate }, "wbotMessageListener: messages.update");
      if (messageUpdate.length === 0) return;
      messageUpdate.forEach(async (message: WAMessageUpdate) => {
        (wbot as WASocket)!.readMessages([message.key]);

        await ackMutex.runExclusive(async () => {
          handleMsgAck(message, message.update.status);
        });
      });
    });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(`Error handling wbot message listener. Err: ${error}`);
  }
};

export { wbotMessageListener, handleMessage };
