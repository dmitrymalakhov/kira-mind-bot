import { Bot } from "grammy";
import { BotContext } from "../types";
import { GoogleMapsService } from "../services/googleMaps";
import { devLog } from "../utils";
import { addToHistory } from "../utils/history";

// ── Регистрация обработчика геолокации ─────────────────────

export function registerLocationMessageHandler(bot: Bot<BotContext>): void {
    bot.on("message:location", async (ctx) => {
        try {
            devLog('📍 Получена геолокация от пользователя:', ctx.from?.id);
            const location = ctx.message.location;
            const latitude = location.latitude;
            const longitude = location.longitude;

            await addToHistory(ctx, 'user', `[Геолокация: ${latitude}, ${longitude}]`);

            ctx.session.lastLocation = {
                latitude,
                longitude,
                timestamp: new Date()
            };

            await ctx.api.sendChatAction(ctx.chat.id, "typing");

            try {
                const mapsService = new GoogleMapsService();
                const geocodingResult = await mapsService.geocodeAddress(`${latitude},${longitude}`);

                if (geocodingResult && geocodingResult.formatted_address) {
                    ctx.session.lastLocation.address = geocodingResult.formatted_address;

                    const responseText = `Я получила твою геолокацию! 📍\n\nТы находишься по адресу: ${geocodingResult.formatted_address}\n\nТеперь ты можешь спросить меня о местах поблизости, например:\n- Найди кафе рядом\n- Где ближайшая аптека?\n- Покажи рестораны в радиусе 1 км`;

                    await addToHistory(ctx, 'bot', responseText);
                    await ctx.reply(responseText);
                } else {
                    const responseText = `Я получила твою геолокацию (${latitude}, ${longitude})! 📍\n\nТеперь ты можешь спросить меня о местах поблизости, например:\n- Найди кафе рядом\n- Где ближайшая аптека?\n- Покажи рестораны в радиусе 1 км`;

                    await addToHistory(ctx, 'bot', responseText);
                    await ctx.reply(responseText);
                }
            } catch (geocodingError) {
                console.error("Ошибка при геокодировании:", geocodingError);

                const responseText = `Я получила твою геолокацию! 📍\n\nКоординаты: ${latitude}, ${longitude}\n\nТеперь ты можешь спросить меня о местах поблизости, например:\n- Найди кафе рядом\n- Где ближайшая аптека?\n- Покажи рестораны в радиусе 1 км`;

                await addToHistory(ctx, 'bot', responseText);
                await ctx.reply(responseText);
            }
        } catch (error) {
            console.error("Ошибка при обработке геолокации:", error);
            await ctx.reply("Произошла ошибка при обработке твоей геолокации. Пожалуйста, попробуй еще раз или укажи местоположение в сообщении. 🌍");
        }
    });
}
