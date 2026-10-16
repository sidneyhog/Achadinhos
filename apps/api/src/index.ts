import { migrate } from "./db";
import { app } from "./http";

const port = Number(process.env.PORT || 4000);

await migrate();
app.listen(port, () => {
  console.log(`Achadinhos API em :${port}`);
});
