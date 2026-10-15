// Renders every built-in mail with its sample data into examples/ (git-ignored): <id>.html,
// <id>.txt and <id>.eml. Open the .html in a browser or the .eml in a mail app.
import { mkdirSync, writeFileSync } from "node:fs";
import { buildMessage, MAIL_TEMPLATES } from "../src/index";

const brand = {
  name: "Maa Gayatri Path Lab",
  addressLines: ["Arang, Raipur, Chhattisgarh"],
  phone: "+91-00000-00000",
  website: "https://example.com",
};
mkdirSync("examples", { recursive: true });
for (const t of Object.values(MAIL_TEMPLATES)) {
  const r = t.render(t.sample as never, { brand });
  writeFileSync(`examples/${t.id}.html`, r.html);
  writeFileSync(`examples/${t.id}.txt`, r.text);
  const eml = buildMessage({ from: "MGPL <no-reply@example.com>", to: "Kavita Sharma <kavita.sharma@example.com>", subject: r.subject, html: r.html, text: r.text });
  writeFileSync(`examples/${t.id}.eml`, eml.raw);
  console.log(`examples/${t.id}.html  ${r.subject}`);
}
