import { Hono } from "hono";
export { Counter } from "./counter.js";
const app = new Hono();
app.get("/", (c) => c.text("hi"));
export default app;
