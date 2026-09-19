import { isIP } from "node:net";
import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from "@modelcontextprotocol/server/validators/ajv";

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addFormat("cidr", (value: string) => {
  const [address, prefix, extra] = value.split("/");
  if (!address || !prefix || extra !== undefined || !/^\d+$/.test(prefix))
    return false;
  const version = isIP(address);
  return version !== 0 && Number(prefix) <= (version === 4 ? 32 : 128);
});
export const schemaValidator = new AjvJsonSchemaValidator(ajv);
