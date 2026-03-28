import * as dotenv from "dotenv";
import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { GoogleMapsService, PlaceResult } from "../services/googleMaps";
import { devLog } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import openai from "../openai";

// Загрузка переменных окружения
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });


// Инициализация Google Maps Service
const mapsService = new GoogleMapsService();

// Интерфейс для результата обработки запроса к картам
interface MapsQueryResult {
    queryType: 'directions' | 'place_search' | 'address_lookup' | 'unknown';
    origin?: string;
    destination?: string;
    location?: string;
    placeType?: string;
    address?: string;
    travelMode?: 'driving' | 'walking' | 'transit' | 'bicycling';
    searchRadius?: number;
    keyword?: string;
}

/**
 * Анализирует запрос пользователя для определения типа запроса к картам
 * @param message Текст сообщения
 * @param messageHistory История сообщений
 * @returns Результат анализа запроса к картам
 */
async function analyzeMapsQuery(
    message: string,
    messageHistory: MessageHistory[] = [],
    memoryContext: string = ""
): Promise<MapsQueryResult> {
    try {
        // Подготовка истории сообщений для контекста
        let historyContext = "";
        if (messageHistory.length > 0) {
            historyContext = "\nИстория переписки (от старых к новым):\n";
            messageHistory.forEach((item, index) => {
                historyContext += `${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'Бот'}: ${item.content}\n`;
            });
        }

        const lastLocationMessage = messageHistory.find(msg =>
            msg.role === 'user' && msg.content.includes('[Геолокация:')
        );
        let locationContext = "";
        if (lastLocationMessage) {
            locationContext = "\nПользователь недавно поделился своей геолокацией. Учитывай это при интерпретации таких слов как 'рядом', 'поблизости', 'отсюда', которые могут относиться к текущему местоположению пользователя.";
        }

        // Подготовка промпта для анализа запроса к картам
        const prompt = `
        Проанализируй следующее сообщение, которое может содержать запрос связанный с картами и локациями:

        "${message}"
        ${historyContext}
        ${memoryContext}
        ${locationContext}
        
        Определи, что именно пользователь хочет узнать:
        1. Проложить маршрут между точками (directions)
        2. Найти места определенного типа рядом с локацией (place_search)
        3. Узнать информацию об адресе или координатах (address_lookup)
        4. Запрос не связан с картами (unknown)

        Извлеки все возможные параметры:
        - Начальная точка маршрута (origin)
        - Конечная точка маршрута (destination)
        - Локация для поиска мест (location)
        - Тип места для поиска (placeType): restaurant, cafe, hospital, pharmacy, school, etc.
        - Адрес для поиска информации (address)
        - Способ передвижения (travelMode): driving, walking, transit, bicycling
        - Радиус поиска в метрах (searchRadius)
        - Ключевые слова для поиска (keyword)

        Ответ предоставь в формате JSON:
        {
          "queryType": "directions | place_search | address_lookup | unknown",
          "origin": "начальная точка маршрута (если применимо)",
          "destination": "конечная точка маршрута (если применимо)",
          "location": "локация для поиска мест (если применимо)",
          "placeType": "тип места для поиска (если применимо)",
          "address": "адрес для поиска информации (если применимо)",
          "travelMode": "способ передвижения (если указан)",
          "searchRadius": число (радиус поиска в метрах, если указан),
          "keyword": "ключевые слова для поиска (если указаны)"
        }
        `;

        // Отправка запроса к API OpenAI
        const response = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Ты - специализированный аналитический агент, который определяет запросы пользователей, связанные с картами и навигацией.
                    Ты умеешь классифицировать запросы по типам и извлекать важные параметры для обработки в Google Maps API.
                    Ты внимателен к деталям, учитываешь контекст и правильно определяешь намерение пользователя.`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.3,
        });

        // Получаем текст ответа
        const aiResponse = response.choices[0]?.message?.content || "";
        devLog("Maps Query Analysis Response:", aiResponse);

        // Парсим JSON из ответа
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("Could not parse JSON from AI response");
        }

        // Парсим JSON
        const result: MapsQueryResult = JSON.parse(jsonMatch[0]);
        return result;

    } catch (error) {
        console.error("Error analyzing maps query:", error);
        // Возвращаем стандартный результат в случае ошибки
        return {
            queryType: "unknown"
        };
    }
}

/**
 * Агент для обработки запросов, связанных с картами и локациями
 * @param message Текст сообщения
 * @param isForwarded Является ли сообщение пересланным
 * @param forwardFrom Информация о первоначальном отправителе
 * @param messageHistory История сообщений
 * @returns Результат обработки сообщения
 */
export async function mapsAgent(
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    lastLocation?: { latitude: number; longitude: number; address?: string; },
    memoryContext: string = ""
): Promise<ProcessingResult> {
    try {
        // Анализируем запрос пользователя
        const queryResult = await analyzeMapsQuery(message, messageHistory, memoryContext);

        // Если запрос не связан с картами, возвращаем соответствующий результат
        if (queryResult.queryType === "unknown") {
            return {
                responseText: "Кажется, твой запрос не связан с картами или местоположением. Могу я помочь тебе чем-то еще? Если ты хочешь узнать маршрут или найти места поблизости, укажи более точную информацию. 🗺️"
            };
        }

        // Если геолокация доступна и в запросе указаны относительные понятия
        // такие как "рядом", "поблизости", "ближайший" и не указана конкретная локация
        if (lastLocation &&
            (message.toLowerCase().includes("рядом") ||
                message.toLowerCase().includes("поблизости") ||
                message.toLowerCase().includes("ближайш") ||
                message.toLowerCase().includes("около") ||
                message.toLowerCase().includes("недалеко")) &&
            !queryResult.location) {

            // Используем текущую геолокацию пользователя
            if (queryResult.queryType === "place_search") {
                queryResult.location = `${lastLocation.latitude},${lastLocation.longitude}`;
                devLog(`Using user's last location for search: ${queryResult.location}`);
            }
        }

        // Обрабатываем запрос в зависимости от типа
        switch (queryResult.queryType) {
            case "directions":
                // Если требуется проложить маршрут от текущего местоположения
                if (lastLocation &&
                    (message.toLowerCase().includes("отсюда") ||
                        message.toLowerCase().includes("от меня") ||
                        message.toLowerCase().includes("от моего местоположения")) &&
                    !queryResult.origin) {

                    queryResult.origin = `${lastLocation.latitude},${lastLocation.longitude}`;
                    devLog(`Using user's last location as origin: ${queryResult.origin}`);
                }
                return await processDirectionsQuery(queryResult, message, messageHistory);

            case "place_search":
                return await processPlaceSearchQuery(queryResult, message, messageHistory);

            case "address_lookup":
                return await processAddressLookupQuery(queryResult, message, messageHistory);

            default:
                return {
                    responseText: "Извини, но я не смогла точно определить, что ты хочешь узнать. Можешь уточнить свой запрос? Например, 'Как добраться от Кремля до Большого театра' или 'Найди кафе рядом с метро Маяковская'. 🗺️"
                };
        }
    } catch (error) {
        console.error("Error in maps agent:", error);
        // В случае ошибки возвращаем стандартный ответ
        return {
            responseText: "Произошла ошибка при обработке запроса, связанного с картами. Пожалуйста, попробуй сформулировать запрос по-другому или проверь подключение к сервисам карт. 🗺️"
        };
    }
}

/**
 * Обрабатывает запрос на построение маршрута
 * @param queryResult Результат анализа запроса
 * @param originalMessage Исходное сообщение пользователя
 * @param messageHistory История сообщений
 * @returns Результат обработки запроса
 */
async function processDirectionsQuery(
    queryResult: MapsQueryResult,
    originalMessage: string,
    messageHistory: MessageHistory[] = []
): Promise<ProcessingResult> {
    try {
        // Проверяем наличие необходимых параметров
        if (!queryResult.origin || !queryResult.destination) {
            // Если не хватает параметров, запрашиваем уточнение
            return {
                responseText: "Для построения маршрута мне нужно знать точку отправления и назначения. Пожалуйста, укажи их более конкретно. Например: 'Как добраться от Кремля до Большого театра'. 🚗"
            };
        }

        // Определяем режим передвижения (по умолчанию - driving)
        const travelMode = queryResult.travelMode || 'driving';

        // Получаем маршрут через Google Maps API
        const directions = await mapsService.getDirections(
            queryResult.origin,
            queryResult.destination,
            travelMode
        );

        if (!directions) {
            return {
                responseText: `К сожалению, не удалось построить маршрут от "${queryResult.origin}" до "${queryResult.destination}". Пожалуйста, проверь правильность адресов или попробуй другие точки маршрута. 🚫`
            };
        }

        // Форматируем инструкции маршрута
        const formattedDirections = mapsService.formatDirections(directions);

        // Получаем URL статической карты для маршрута
        const mapUrl = mapsService.getStaticMapUrl(
            queryResult.origin,
            13,
            '600x400',
            [`color:green|label:A|${queryResult.origin}`, `color:red|label:B|${queryResult.destination}`]
        );

        // Формируем ответ пользователю
        const travelModeEmoji = {
            'driving': '🚗',
            'walking': '🚶',
            'transit': '🚌',
            'bicycling': '🚲'
        }[travelMode];

        const responseText = `${travelModeEmoji} Вот маршрут от ${queryResult.origin} до ${queryResult.destination}:\n\n${formattedDirections}\n\nЯ также подготовила карту для наглядности. Счастливого пути! 🗺️`;

        // Возвращаем результат с URL статической карты
        return {
            responseText,
            imageGenerated: true,
            generatedImageUrl: mapUrl
        };
    } catch (error) {
        console.error("Error processing directions query:", error);
        return {
            responseText: "Произошла ошибка при построении маршрута. Пожалуйста, проверь правильность адресов и попробуй еще раз. 🚫"
        };
    }
}

/**
 * Обрабатывает запрос на поиск мест
 * @param queryResult Результат анализа запроса
 * @param originalMessage Исходное сообщение пользователя
 * @param messageHistory История сообщений
 * @returns Результат обработки запроса
 */
async function processPlaceSearchQuery(
    queryResult: MapsQueryResult,
    originalMessage: string,
    messageHistory: MessageHistory[] = []
): Promise<ProcessingResult> {
    try {
        // Проверяем наличие необходимых параметров
        if (!queryResult.location) {
            return {
                responseText: "Для поиска мест мне нужно знать локацию. Пожалуйста, укажи, где именно искать. Например: 'Найди кафе рядом с Красной площадью'. 📍"
            };
        }

        // Определяем радиус поиска (по умолчанию - 1000 метров)
        const radius = queryResult.searchRadius || 1000;

        // Ищем места через Google Maps API
        const places = await mapsService.searchNearbyPlaces(
            queryResult.location,
            radius,
            queryResult.placeType,
            queryResult.keyword
        );

        if (!places || places.length === 0) {
            return {
                responseText: `К сожалению, не удалось найти ${queryResult.placeType || "места"} рядом с "${queryResult.location}" в радиусе ${radius} метров. Пожалуйста, попробуй изменить параметры поиска. 🚫`
            };
        }

        // Форматируем результаты поиска
        const formattedPlaces = mapsService.formatPlaces(places);

        // Получаем URL статической карты для найденных мест
        // Сначала геокодируем локацию для получения координат
        const geocoded = await mapsService.geocodeAddress(queryResult.location);

        let mapUrl = "";
        if (geocoded) {
            const { lat, lng } = geocoded.geometry.location;
            const center = `${lat},${lng}`;


            // Создаем маркеры для первых 5 мест
            const markers = places.slice(0, 5).map((place: PlaceResult, index: number) => {
                // Убедимся, что у места есть геометрия и координаты
                if (place.geometry && place.geometry.location) {
                    return `color:red|label:${index + 1}|${place.geometry.location.lat},${place.geometry.location.lng}`;
                }
                return null;
            }).filter(Boolean) as string[];

            // Добавляем маркер для центра поиска
            markers.unshift(`color:green|label:S|${center}`);

            mapUrl = mapsService.getStaticMapUrl(center, 14, '600x400', markers);
        }

        // Формируем ответ пользователю
        let responseText = `🔍 Вот что я нашла ${queryResult.placeType ? `(${queryResult.placeType})` : ""} рядом с ${queryResult.location}:\n\n${formattedPlaces}`;

        if (mapUrl) {
            responseText += "\nЯ также подготовила карту для наглядности. Приятного посещения! 🗺️";

            return {
                responseText,
                imageGenerated: true,
                generatedImageUrl: mapUrl
            };
        } else {
            return {
                responseText
            };
        }
    } catch (error) {
        console.error("Error processing place search query:", error);
        return {
            responseText: "Произошла ошибка при поиске мест. Пожалуйста, проверь правильность локации и попробуй еще раз. 🚫"
        };
    }
}

/**
 * Обрабатывает запрос на поиск информации об адресе
 * @param queryResult Результат анализа запроса
 * @param originalMessage Исходное сообщение пользователя
 * @param messageHistory История сообщений
 * @returns Результат обработки запроса
 */
async function processAddressLookupQuery(
    queryResult: MapsQueryResult,
    originalMessage: string,
    messageHistory: MessageHistory[] = []
): Promise<ProcessingResult> {
    try {
        // Проверяем наличие необходимых параметров
        if (!queryResult.address) {
            return {
                responseText: "Для поиска информации о месте мне нужен адрес или название локации. Пожалуйста, укажи его более конкретно. Например: 'Что находится по адресу Тверская 13' или 'Информация о ГУМе'. 📍"
            };
        }

        // Выполняем геокодирование адреса
        const geocoded = await mapsService.geocodeAddress(queryResult.address);

        if (!geocoded) {
            return {
                responseText: `К сожалению, не удалось найти информацию о "${queryResult.address}". Пожалуйста, проверь правильность адреса или попробуй более точное описание. 🚫`
            };
        }

        // Получаем URL статической карты для адреса
        const { lat, lng } = geocoded.geometry.location;
        const mapUrl = mapsService.getStaticMapUrl(
            `${lat},${lng}`,
            15,
            '600x400',
            [`color:red|${lat},${lng}`]
        );

        // Формируем ответ пользователю
        const responseText = `📍 Информация о локации "${queryResult.address}":\n\n` +
            `Полный адрес: ${geocoded.formatted_address}\n` +
            `Координаты: ${lat}, ${lng}\n` +
            `ID места: ${geocoded.place_id}\n\n` +
            `Я также подготовила карту для наглядности. 🗺️`;

        // Возвращаем результат с URL статической карты
        return {
            responseText,
            imageGenerated: true,
            generatedImageUrl: mapUrl
        };
    } catch (error) {
        console.error("Error processing address lookup query:", error);
        return {
            responseText: "Произошла ошибка при поиске информации об адресе. Пожалуйста, проверь правильность адреса и попробуй еще раз. 🚫"
        };
    }
}