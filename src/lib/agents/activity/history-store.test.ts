import { describe } from "vitest";
import { historyStoreContract } from "./history-store.contract";
import { createMemoryAgentHistoryStore } from "./history-store";

describe("the in-memory agent history store keeps the store contract", () => {
  historyStoreContract(async () => createMemoryAgentHistoryStore());
});
