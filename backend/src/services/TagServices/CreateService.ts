import * as Yup from "yup";

import AppError from "../../errors/AppError";
import Tag from "../../models/Tag";
import { generateColor } from "../../helpers/colorGenerator";

interface Request {
  name: string;
  color: string;
  kanban: number;
  companyId: number;
}

const CreateService = async ({
  name,
  color,
  kanban,
  companyId
}: Request): Promise<Tag> => {
  const schema = Yup.object().shape({
    name: Yup.string().required().min(3)
  });

  try {
    await schema.validate({ name });
  } catch (err: any) {
    throw new AppError(err.message);
  }

  if (kanban === null) {
    kanban = 0;
  }

  if (!color) {
    color = generateColor(name);
  }

  const [tag] = await Tag.findOrCreate({
    where: { name, color, kanban, companyId },
    defaults: { name, color, kanban, companyId }
  });

  await tag.reload();

  return tag;
};

export default CreateService;
