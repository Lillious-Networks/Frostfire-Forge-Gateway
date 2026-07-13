import sendEmail, { buildEmailBody, buildCodeAction } from "./email";
import log from "../modules/logger";
import query from "../controllers/sqldatabase";

function verify(token: string, useremail: string, username: string): Promise<void> {
    return new Promise((resolve, reject) => {
        async function execute() {
            try {
                if (!token || !useremail || !username) {
                    return reject(new Error("Invalid input"));
                }
                useremail = useremail.toLowerCase();
                username = username.toLowerCase();

                const gameName = process.env.GAME_NAME || "Frostfire Forge";
                const subject = "Verify your account";
                const code = shuffle(token, 6);

                const message = buildEmailBody(
                  "Verify Your Account",
                  `Enter the code below to verify your account for <strong>${username}</strong>.`,
                  buildCodeAction(code)
                );

                const emailResponse = await sendEmail(useremail, subject, gameName, message);
                if (emailResponse !== "Email sent successfully") {
                    return reject(new Error("Failed to send email"));
                }

                const sql = await query(`UPDATE accounts SET verification_code = ?, verified = ? WHERE username = ? AND email = ?`, [code, 0, username, useremail]);
                if (!sql) {
                    return reject(new Error("An unexpected error occurred"));
                }

                resolve();
            } catch (error: any) {
                log.error(error);
                reject("An unexpected error occurred");
            }
        }
        execute();
    });
}

export function shuffle(str: string, length: number) {
    length = length || 6;
    const arr = str.split("");
    let n = arr.length;
    while (n > 0) {
      const i = Math.floor(Math.random() * n--);
      const tmp = arr[n];
      arr[n] = arr[i];
      arr[i] = tmp;
    }
    return arr.join("").slice(0, length).toUpperCase();
  }

  export default verify;