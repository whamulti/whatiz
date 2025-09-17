import { FindOptions, Op } from "sequelize";
import AppError from "../../errors/AppError";
import Message from "../../models/Message";
import OldMessage from "../../models/OldMessage";
import Ticket from "../../models/Ticket";
import ShowTicketService from "../TicketServices/ShowTicketService";
import Queue from "../../models/Queue";
import { GetCompanySetting } from "../../helpers/CheckSettings";

interface Request {
  ticketId: string;
  companyId: number;
  pageNumber?: string;
  queues?: number[];
}

interface Response {
  messages: Message[];
  ticket: Ticket;
  count: number;
  hasMore: boolean;
}

const ListMessagesService = async ({
  pageNumber = "1",
  ticketId,
  companyId,
  queues = []
}: Request): Promise<Response> => {
  const ticket = await ShowTicketService(ticketId, companyId);

  if (!ticket) {
    throw new AppError("ERR_NO_TICKET_FOUND", 404);
  }

  const limit = 100;
  const offset = limit * (+pageNumber - 1);

  const options: FindOptions = {
    where: {
      ticketId,
      companyId,
      mediaType: {
        [Op.or]: {
          [Op.ne]: "reactionMessage",
          [Op.is]: null
        }
      }
    }
  };

  if (
    queues.length > 0 &&
    (await GetCompanySetting(companyId, "messageVisibility", "message")) ===
      "message"
  ) {
    // eslint-disable-next-line dot-notation
    options.where["queueId"] = {
      [Op.or]: {
        [Op.in]: queues,
        [Op.eq]: null
      }
    };
  }

  const { count, rows: messages } = await Message.findAndCountAll({
    ...options,
    limit,
    include: [
      "contact",
      {
        model: Message,
        as: "quotedMsg",
        include: ["contact"],
        where: {
          companyId: ticket.companyId
        },
        required: false
      },
      {
        model: OldMessage,
        as: "oldMessages",
        where: {
          ticketId: ticket.id
        },
        required: false
      },
      {
        model: Message,
        as: "replies",
        where: {
          ticketId: ticket.id
        },
        include: ["contact"],
        required: false
      },
      {
        model: Queue,
        as: "queue"
      }
    ],
    offset,
    order: [["createdAt", "DESC"]]
  });

  const hasMore = count > offset + messages.length;

  return {
    messages: messages.reverse(),
    ticket,
    count,
    hasMore
  };
};

export default ListMessagesService;
