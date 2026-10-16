import { migrate } from "./db";
import { app } from "./http";
import { assertAppSecret, loadAutoSecrets } from "./secrets";

const port = Number(process.env.PORT || 4000);

loadAutoSecrets("api");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET não está definido no .env. A API não sobe sem ele, porque o valor padrão permitiria forjar login.");
  process.exit(1);
}
assertAppSecret("api");

await migrate();
app.listen(port, () => {
  console.log(`Achadinhos API em :${port}`);
});
