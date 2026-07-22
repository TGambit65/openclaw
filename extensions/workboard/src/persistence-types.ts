// Workboard plugin module implements persistence types behavior.
import type {
  WorkboardAttachment,
  WorkboardBoardMetadata,
  WorkboardCard,
  WorkboardNotificationSubscription,
} from "./types.js";

export type PersistedWorkboardCard = {
  version: 1;
  card: WorkboardCard;
};

export type PersistedWorkboardBoard = {
  version: 1;
  board: WorkboardBoardMetadata;
};

export type PersistedWorkboardNotificationSubscription = {
  version: 1;
  subscription: WorkboardNotificationSubscription;
};

export type PersistedWorkboardAttachment = {
  version: 1;
  attachment: WorkboardAttachment;
  contentBase64: string;
};

export type WorkboardCardCompareAndSwapOptions = {
  expectedRevision: string;
  ownerSlotId?: string;
  ignoredOwnerSlotCardIds?: readonly string[];
};

export type WorkboardCardCompareAndSwapResult = "updated" | "stale" | "owner_busy";

export type WorkboardCardBatchCheck =
  | { key: string; expectedRevision: string; expectedAbsent?: never }
  | { key: string; expectedRevision?: never; expectedAbsent: true };

export type WorkboardCardBatchUpsert = {
  key: string;
  value: PersistedWorkboardCard;
};

export type WorkboardCardBatchMutation = {
  /** Full read set whose revisions make the staged graph update serializable. */
  checks: WorkboardCardBatchCheck[];
  upserts: WorkboardCardBatchUpsert[];
};

export type WorkboardCardBatchMutationResult = "updated" | "stale";

export type WorkboardKeyedStore<T = PersistedWorkboardCard> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: T }>>;
  compareAndSwap?(
    key: string,
    value: T,
    options: WorkboardCardCompareAndSwapOptions,
  ): Promise<WorkboardCardCompareAndSwapResult>;
  compareAndSwapBatch?(
    mutation: WorkboardCardBatchMutation,
  ): Promise<WorkboardCardBatchMutationResult>;
};
