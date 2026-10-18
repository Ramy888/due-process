import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In development the desk server (port 8787) answers the API; the built UI is served by that server itself.
const desk = "http://127.0.0.1:8787";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: Object.fromEntries(["/state", "/events", "/scenario", "/approvals", "/case", "/trails"].map((p) => [p, desk])),
  },
});
