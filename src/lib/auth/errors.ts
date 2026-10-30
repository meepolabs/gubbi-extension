// The reconnect error is part of the TokenProvider contract; it is re-exported
// here so auth code and its callers keep one import site within the module.
export { ReconnectRequiredError } from "../token-provider";
