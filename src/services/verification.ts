import sendEmail, { buildEmailBody, buildCodeAction } from "./email";
import log from "../modules/logger";
import query from "../controllers/sqldatabase";

function verify(token: string, useremail: string, username: string, purpose: 'account' | 'login' = 'login'): Promise<void> {
    return new Promise((resolve, reject) => {
        async function execute() {
            try {
                if (!token || !useremail || !username) {
                    return reject(new Error("Invalid input"));
                }
                useremail = useremail.toLowerCase();
                username = username.toLowerCase();

                const gameName = process.env.GAME_NAME || "Frostfire Forge";

                const isAccount = purpose === 'account';
                const subject = isAccount ? "Verify your email address" : "Login verification code";
                const title = isAccount ? "Verify Your Email Address" : "Login Verification";
                const desc = isAccount
                  ? `Enter the code below to confirm your email address for <strong>${username}</strong>.`
                  : `Enter the code below to sign in to your account.`;

                const code = shuffle(token, 6);

                const message = buildEmailBody(title, desc, buildCodeAction(code));

                const emailResponse = await sendEmail(useremail, subject, gameName, message);
                if (emailResponse !== "Email sent successfully") {
                    return reject(new Error("Failed to send email"));
                }

                const sql = await query(`UPDATE accounts SET verification_code = ? WHERE username = ? AND email = ?`, [code, username, useremail]);
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