import * as http from "http";
import { getTelegramUserClientHealth } from "./telegram";

const DEFAULT_RUNTIME_HEALTH_PORT = Number(process.env.KIRA_RUNTIME_HEALTH_PORT || 3100);

let runtimeHealthServerStarted = false;

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}

export function startRuntimeHealthServer(port: number = DEFAULT_RUNTIME_HEALTH_PORT): void {
    if (runtimeHealthServerStarted) {
        return;
    }

    const server = http.createServer(async (req, res) => {
        const method = req.method || "GET";
        const url = req.url || "/";

        if (method !== "GET") {
            sendJson(res, 405, { error: "Method Not Allowed" });
            return;
        }

        if (url === "/internal/health") {
            sendJson(res, 200, {
                ok: true,
                service: "kira-mind-bot",
                checkedAt: new Date().toISOString(),
            });
            return;
        }

        if (url === "/internal/health/telegram-user") {
            try {
                const health = await getTelegramUserClientHealth();
                const statusCode = health.status === "down" ? 503 : 200;
                sendJson(res, statusCode, health);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                sendJson(res, 500, {
                    status: "down",
                    summary: "Не удалось собрать Telegram user-client health.",
                    details: message,
                    checkedAt: new Date().toISOString(),
                });
            }
            return;
        }

        sendJson(res, 404, { error: "Not Found" });
    });

    server.on("error", (error) => {
        console.error("[runtime-health] failed to start server:", error);
    });

    server.listen(port, "0.0.0.0", () => {
        console.log(`[runtime-health] listening on 0.0.0.0:${port}`);
    });

    runtimeHealthServerStarted = true;
}
