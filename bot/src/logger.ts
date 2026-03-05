import pino from "pino";
import { config } from "./config.js";

export default pino({ level: config.logLevel });
