import config from "./config.js";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

const socket = DjsConnect(
    config.deliveroo.host,
    config.deliveroo.agents.bdi.token
);

export { socket };
