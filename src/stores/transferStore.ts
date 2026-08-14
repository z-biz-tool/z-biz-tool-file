import { create } from "zustand";

export interface TransferItem {
  id: string;
  sourcePath: string;
  sourceName: string;
  destDir: string;
  operation: "copy" | "move";
  status: "pending" | "running" | "done" | "error";
  error?: string;
}

interface TransferStore {
  items: TransferItem[];
  addTransfer: (item: Omit<TransferItem, "id" | "status">) => void;
  updateStatus: (id: string, status: TransferItem["status"], error?: string) => void;
  removeCompleted: () => void;
}

export const useTransferStore = create<TransferStore>((set) => ({
  items: [],

  addTransfer: (item) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          ...item,
          id: crypto.randomUUID(),
          status: "pending" as const,
        },
      ],
    })),

  updateStatus: (id, status, error) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, status, error } : item
      ),
    })),

  removeCompleted: () =>
    set((state) => ({
      items: state.items.filter((item) => item.status !== "done" && item.status !== "error"),
    })),
}));
