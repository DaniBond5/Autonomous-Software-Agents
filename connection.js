import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import { AgentData } from "./Belief/AgentData.js";

const socket = DjsConnect();

export{socket}