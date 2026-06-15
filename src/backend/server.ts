import { openDatabase } from "../persistence/database.js";
import { createApp } from "./app.js";

const db = openDatabase();
const app = createApp(db);
const port = Number(process.env.PORT ?? 3001);

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
