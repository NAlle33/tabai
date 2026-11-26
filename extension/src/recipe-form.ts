import type { PanelRecipe } from "../../shared/control-panel";
import { isSecretParameter } from "../../shared/workflow-schema";
import { node } from "./panel-views";


// The decimal numbers a number input accepts. A masked number field is a text
// field, so the form refuses anything else before Number() turns it into NaN.
const SECRET_NUMBER_PATTERN = "[+\\-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+\\-]?\\d+)?";

function parameterInput(type: "string" | "number" | "boolean", secret: boolean) {
  if (type === "boolean") {
    const input = node("select");
    input.append(new Option("Välj värde", ""), new Option("Ja", "true"), new Option("Nej", "false"));
    return input;
  }
  const input = node("input");
  // A secret stays masked while it is typed, a number included (a PIN or a
  // one-time code is recorded as one); collectParameters still converts it by
  // its declared type.
  input.type = secret ? "password" : type === "number" ? "number" : "text";
  if (type === "number" && secret) {
    input.inputMode = "decimal";
    input.pattern = SECRET_NUMBER_PATTERN;
  } else if (type === "number") input.step = "any";
  return input;
}


export function collectParameters(recipe: PanelRecipe, fields: HTMLElement) {
  const parameters: Record<string, string | number | boolean> = {};
  const inputs = fields.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-parameter]");
  for (const input of inputs) {
    const name = input.dataset.parameter!;
    const definition = recipe.parameters[name];
    if (!input.value && (definition.required === false || definition.default !== undefined) && definition.type !== "string") continue;
    if (!input.value && definition.required === false && definition.default === undefined) continue;
    parameters[name] = definition.type === "boolean"
      ? input.value === "true"
      : definition.type === "number"
        ? Number(input.value)
        : input.value;
  }
  return parameters;
}
export function renderParameterFields(recipe: PanelRecipe | undefined, fields: HTMLElement) {
  Object.entries(recipe?.parameters ?? {}).forEach(([name, definition], index) => {
    const field = node("div", "", "field");
    const label = node("label", `${name}${definition.required === false ? " (valfri)" : ""}`);
    const id = `parameter-${index}`;
    // The reserved name prefix marks a secret, which stays masked while it is typed.
    const secret = (definition.type === "string" || definition.type === "number") && isSecretParameter(name);
    const input = parameterInput(definition.type, secret);
    label.htmlFor = id;
    input.id = id;
    input.dataset.parameter = name;
    input.autocomplete = "off";
    input.value = definition.default === undefined ? "" : String(definition.default);
    // A required parameter without a default cannot be sent empty, strings included.
    input.required = definition.required !== false && definition.default === undefined;
    const secretHelp = definition.type === "number" ? "Hemligt tal. Det visas inte medan du skriver." : "Hemlig text. Den visas inte medan du skriver.";
    const help = node("p", definition.description || (secret ? secretHelp : { string: "Text", number: "Tal", boolean: "Ja eller nej" }[definition.type]), "muted");
    help.id = `${id}-help`;
    input.setAttribute("aria-describedby", help.id);
    field.append(label, input, help);
    fields.append(field);
  });
}
