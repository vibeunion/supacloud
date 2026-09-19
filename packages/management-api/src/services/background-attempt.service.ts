import { sql } from "../db";
import { createBackgroundAttemptStore } from "../repositories/background-attempt-store";

export const backgroundAttemptStore = createBackgroundAttemptStore(sql);
