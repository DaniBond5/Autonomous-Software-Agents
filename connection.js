import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { AgentData } from "./belief/AgentData.js";

const socket = DjsConnect();

export{socket}