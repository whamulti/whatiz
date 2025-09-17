/*

   DO NOT REMOVE / NÃO REMOVER

   VERSÃO EM PORTUGUÊS MAIS ABAIXO

   
   BASIC LICENSE INFORMATION:

   Author: Claudemir Todo Bom
   Email: claudemir@todobom.com
   
   Licensed under the AGPLv3 as stated on LICENSE.md file
   
   Any work that uses code from this file is obligated to 
   give access to its source code to all of its users (not only
   the system's owner running it)
   
   EXCLUSIVE LICENSE to use on closed source derived work can be
   purchased from the author and put at the root of the source
   code tree as proof-of-purchase.



   INFORMAÇÕES BÁSICAS DE LICENÇA

   Autor: Claudemir Todo Bom
   Email: claudemir@todobom.com

   Licenciado sob a licença AGPLv3 conforme arquivo LICENSE.md
    
   Qualquer sistema que inclua este código deve ter o seu código
   fonte fornecido a todos os usuários do sistema (não apenas ao
   proprietário da infraestrutura que o executa)
   
   LICENÇA EXCLUSIVA para uso em produto derivado em código fechado
   pode ser adquirida com o autor e colocada na raiz do projeto
   como prova de compra. 
   
 */

import { Request, Response } from "express";
import EfiPay, { EfiCredentials } from "sdk-typescript-apis-efi";
import path from "path";
import GetSuperSettingService from "../SettingServices/GetSuperSettingService";
import { logger } from "../../utils/logger";
import Invoices from "../../models/Invoices";
import Company from "../../models/Company";
import AppError from "../../errors/AppError";
import {
  processInvoiceExpired,
  processInvoicePaid
} from "./PaymentGatewayServices";

const webhookUrl = `${process.env.BACKEND_URL}/subscription/ticketz/webhook`;

const privateFolder = __dirname.endsWith("/dist")
  ? path.resolve(__dirname, "..", "private")
  : path.resolve(__dirname, "..", "..", "..", "private");

async function getEfiOptions(): Promise<EfiCredentials> {
  const cert = `${privateFolder}/${await GetSuperSettingService({
    key: "_efiCertFile"
  })}`;

  return {
    sandbox: false,
    client_id: await GetSuperSettingService({ key: "_efiClientId" }),
    client_secret: await GetSuperSettingService({ key: "_efiClientSecret" }),
    pix_cert: cert,
    validateMtls: false
  };
}

const newEfiPayInstance = async () => {
  const efiOptions = await getEfiOptions();
  return new EfiPay(efiOptions);
};

const createWebHook = async (efiPay: EfiPay) => {
  const params = {
    chave: await GetSuperSettingService({ key: "_efiPixKey" })
  };

  const body = {
    webhookUrl
  };

  return efiPay.pixConfigWebhook(params, body).then(
    (ok: unknown) => {
      logger.info({ result: ok }, "pixConfigWebhook ok");
    },
    (error: unknown) => {
      logger.error({ result: error }, "pixConfigWebhook error:");
    }
  );
};

export const efiInitialize = async () => {
  const paymentGateway = await GetSuperSettingService({
    key: "_paymentGateway"
  });

  if (!webhookUrl.startsWith("https://")) {
    logger.debug("efiInitialize: only SSL webhooks are supported");
    return;
  }

  try {
    if (paymentGateway === "efi") {
      const efiOptions = await getEfiOptions();
      const efiPay = new EfiPay(efiOptions);
      const params = {
        chave: await GetSuperSettingService({ key: "_efiPixKey" })
      };

      efiPay.pixDetailWebhook(params).then(
        (hooks: { webhookUrl: string }) => {
          if (hooks?.webhookUrl !== webhookUrl) {
            createWebHook(efiPay);
          } else {
            logger.debug(
              { result: hooks },
              "efiInitialize: webhook correto já instalado"
            );
          }
        },
        (error: { nome: string }) => {
          if (error?.nome === "webhook_nao_encontrado") {
            createWebHook(efiPay);
          } else {
            logger.error(
              error,
              "efiInitialize: fail to verify current webhook"
            );
          }
        }
      );
    }
  } catch (error) {
    logger.error(error, "efiInitialize: ");
  }
};

export const efiWebhook = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { evento } = req.body;
  if (evento === "teste_webhook") {
    return res.json({ ok: true });
  }
  if (req.body.pix) {
    req.body.pix.forEach(
      async (pix: { status: string; txid: string; valor: number }) => {
        logger.debug(pix, "Processando pagamento");

        const invoice = await Invoices.findOne({
          where: {
            txId: pix.txid,
            status: "open"
          },
          include: { model: Company, as: "company" }
        });

        if (!invoice) {
          logger.debug("efiWebhook: Invoice not found or already paid");
          return true;
        }

        if (pix.valor < invoice.value) {
          logger.debug("Recebido valor menor");
          return true;
        }

        await processInvoicePaid(invoice);
        return true;
      }
    );
  }

  return res.json({ ok: true });
};

export const efiCheckStatus = async (
  invoice: Invoices,
  efiPay: EfiPay = null
): Promise<boolean> => {
  try {
    if (!efiPay) {
      efiPay = await newEfiPayInstance();
    }

    const txDetail = await efiPay.pixDetailCharge({ txid: invoice.txId });

    if (txDetail.status === "ATIVA" || txDetail.status !== "CONCLUIDA") {
      return false;
    }

    const { pix } = txDetail;
    if (pix[0].valor >= invoice.value) {
      await processInvoicePaid(invoice);
      return true;
    }

    return false;
  } catch (error) {
    logger.error(error, "Error getting detail of txid");
  }

  return false;
};

const efiPollCheckStatus = async (
  efiPay: EfiPay,
  invoice: Invoices,
  retries = 10,
  interval = 30000
) => {
  let attempts = 0;

  async function pollStatus(): Promise<void> {
    await invoice.reload();

    if (invoice.status === "paid") {
      logger.debug(
        `efiPollCheckStatus: Invoice ${invoice.id} already paid, finishing polling`
      );
      return;
    }

    const successful = await efiCheckStatus(invoice, efiPay);
    if (successful) {
      return;
    }

    attempts += 1;

    if (attempts >= retries) {
      processInvoiceExpired(invoice);
      return;
    }

    await new Promise(resolve => {
      setTimeout(resolve, interval);
    });
    await pollStatus();
  }

  return pollStatus();
};

export const efiCreateSubscription = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { price, invoiceId } = req.body;

  const body = {
    calendario: {
      expiracao: 300
    },
    valor: {
      original: (Number(price) || 0).toFixed(2)
    },
    chave: await GetSuperSettingService({ key: "_efiPixKey" }),
    solicitacaoPagador: `#Fatura:${invoiceId}`
  };
  const efiOptions = await getEfiOptions();
  try {
    const invoice = await Invoices.findByPk(invoiceId);
    if (!invoice) {
      throw new Error("Invoice not found");
    }

    await efiInitialize();

    const efiPay = new EfiPay(efiOptions);
    const pix = await efiPay.pixCreateImmediateCharge([], body);
    await invoice.update({
      value: price,
      txId: pix.txid,
      payGw: "efi",
      payGwData: JSON.stringify(pix)
    });

    await invoice.reload();

    efiPollCheckStatus(efiPay, invoice);

    return res.json({
      qrcode: { qrcode: pix.pixCopiaECola },
      valor: { original: price }
    });
  } catch (error) {
    logger.error({ efiOptions, error }, "efiCreateSubscription error");
    throw new AppError(
      "Problema encontrado, entre em contato com o suporte!",
      400
    );
  }
};
