import { Request, Response } from "express";
import Translation from "../models/Translation";
// NOTE: não usamos import estático para evitar erro TS2307 quando o arquivo gerado não existir
import AppError from "../errors/AppError";
import { logger } from "../utils/logger";
import { getUniqueLanguages } from "../services/TranslationServices/i18nService";

/**
 * Tentativa segura de carregar o módulo gerado com as translation keys.
 * Se não existir (ex.: build inicial), cai para um fallback que retorna array vazio.
 */
let getAllTranslationKeys: () => string[] = () => [];

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
  const generated = require("../generated/translationKeys");
  if (generated && typeof generated.getAllTranslationKeys === "function") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    getAllTranslationKeys = generated.getAllTranslationKeys;
  } else {
    logger.warn(
      "translationKeys module loaded but doesn't export getAllTranslationKeys. Using empty fallback."
    );
  }
} catch (err) {
  // arquivo não encontrado ou erro ao carregar — deixamos o fallback e logamos
  logger.warn(
    {
      message:
        "translationKeys module not found. Run `npm run generate:i18nkeys` to create it before building.",
      err: (err as Error)?.message ?? err
    },
    "translationKeys missing — using fallback"
  );
}

export const getLanguages = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const languages = await getUniqueLanguages();
  return res.status(200).json(languages);
};

// List all unique languages
export const listLanguages = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const languages = await getUniqueLanguages();
    return res.status(200).json({ languages });
  } catch (error) {
    logger.error(
      {
        message: (error as Error).message,
        stack: (error as Error).stack
      },
      "Error listing languages"
    );
    throw new AppError("ERR_INTERNAL", 500);
  }
};

// Get all keys and values of a namespace and language
export const getKeysAndValues = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { namespace, language } = req.query;

  if (!namespace || !language) {
    throw new AppError("ERR_BAD_REQUEST", 400);
  }

  try {
    // Fetch all keys from translationKeys.ts (ou fallback vazio)
    const allKeys = getAllTranslationKeys();

    // Fetch translations from the database
    const translations = await Translation.findAll({
      where: { namespace, language },
      attributes: ["key", "value"]
    });

    // Create a map of existing translations
    const translationMap = translations.reduce((map, translation) => {
      map[translation.key] = translation.value;
      return map;
    }, {} as Record<string, string>);

    // Combine results, ensuring all keys are included
    const combinedTranslations = allKeys.map(key => ({
      key,
      value: translationMap[key] || ""
    }));

    return res.status(200).json({ translations: combinedTranslations });
  } catch (error) {
    logger.error(
      {
        message: (error as Error).message,
        stack: (error as Error).stack
      },
      "Error fetching keys and values"
    );
    throw new AppError("ERR_INTERNAL", 500);
  }
};

export const upsertTranslation = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { namespace, language, key, value } = req.body;

  if (!namespace || !language || !key) {
    throw new AppError("ERR_BAD_REQUEST", 400);
  }

  try {
    if (value === undefined || value === "") {
      // Remove the record if value is empty
      const deleted = await Translation.destroy({
        where: { namespace, language, key }
      });

      if (deleted) {
        return res.status(200).json({ message: "Translation deleted" });
      }
      throw new AppError("ERR_NOT_FOUND", 404);
    }

    // Upsert the record if value is not empty
    const [translation, created] = await Translation.upsert({
      namespace,
      language,
      key,
      value
    });

    const action = created ? "created" : "updated";

    return res
      .status(200)
      .json({ message: `Translation ${action}`, translation });
  } catch (error) {
    logger.error(
      {
        message: (error as Error).message,
        stack: (error as Error).stack
      },
      "Error upserting translation"
    );
    throw new AppError("ERR_INTERNAL", 500);
  }
};
