import { getStore } from "@netlify/blobs";

export function usersStore() {
  return getStore({ name: "users", consistency: "strong" });
}
