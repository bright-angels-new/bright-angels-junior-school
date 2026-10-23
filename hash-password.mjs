import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = createInterface({ input, output });
try {
  const password = await rl.question("Enter the administrator password (input may be visible in this terminal): ");
  if (!password || password.length < 8) {
    console.error("Use a password with at least 8 characters. A longer password is strongly recommended for production.");
    process.exitCode = 1;
  } else {
    const iterations = 310000;
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const b64 = b => b.toString("base64");
    console.log("\nSet this value as the Cloudflare Worker secret ADMIN_PASSWORD_HASH:\n");
    console.log(`pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`);
    console.log("\nDo not commit this value to Git or place it in frontend code.");
  }
} finally { rl.close(); }
