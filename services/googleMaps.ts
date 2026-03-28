import axios from 'axios';
import * as dotenv from 'dotenv';
import { devLog } from '../utils';

// Загрузка переменных окружения
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

// Интерфейсы для работы с Google Maps API
interface GeocodingResult {
    formatted_address: string;
    place_id: string;
    geometry: {
        location: {
            lat: number;
            lng: number;
        }
    };
}

interface DirectionsResult {
    routes: {
        legs: {
            distance: { text: string; value: number };
            duration: { text: string; value: number };
            steps: {
                html_instructions: string;
                distance: { text: string };
                duration: { text: string };
            }[];
        }[];
        summary: string;
    }[];
}

export interface PlaceResult {
    name: string;
    formatted_address: string;
    rating?: number;
    opening_hours?: {
        open_now: boolean;
    };
    vicinity?: string;
    user_ratings_total?: number;
    photos?: {
        photo_reference: string;
    }[];
    business_status?: string;
    icon?: string;
    icon_background_color?: string;
    icon_mask_base_uri?: string;
    types?: string[];
    price_level?: number;
    geometry: {
        location: {
            lat: number;
            lng: number;
        };
        viewport?: {
            northeast: {
                lat: number;
                lng: number;
            };
            southwest: {
                lat: number;
                lng: number;
            };
        };
    };
}

/**
 * Класс для работы с Google Maps API
 */
export class GoogleMapsService {
    private apiKey: string;
    private baseUrl: string = 'https://maps.googleapis.com/maps/api';

    constructor() {
        this.apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
        if (!this.apiKey) {
            console.warn('GOOGLE_MAPS_API_KEY not set in environment variables');
        }
    }

    /**
     * Получение координат по адресу
     * @param address Адрес для геокодирования
     * @returns Результат геокодирования
     */
    async geocodeAddress(address: string): Promise<GeocodingResult | null> {
        try {
            const response = await axios.get(`${this.baseUrl}/geocode/json`, {
                params: {
                    address,
                    key: this.apiKey,
                    language: 'ru'
                }
            });

            if (response.data.status === 'OK' && response.data.results.length > 0) {
                return response.data.results[0] as GeocodingResult;
            }

            devLog(`Geocoding failed with status: ${response.data.status}`);
            return null;
        } catch (error) {
            console.error('Error geocoding address:', error);
            return null;
        }
    }

    /**
     * Поиск маршрута между двумя точками
     * @param origin Начальная точка (адрес или координаты)
     * @param destination Конечная точка (адрес или координаты)
     * @param mode Режим передвижения (driving, walking, transit, bicycling)
     * @returns Результат построения маршрута
     */
    async getDirections(
        origin: string,
        destination: string,
        mode: 'driving' | 'walking' | 'transit' | 'bicycling' = 'driving'
    ): Promise<DirectionsResult | null> {
        try {
            const response = await axios.get(`${this.baseUrl}/directions/json`, {
                params: {
                    origin,
                    destination,
                    mode,
                    key: this.apiKey,
                    language: 'ru'
                }
            });

            if (response.data.status === 'OK') {
                return response.data as DirectionsResult;
            }

            devLog(`Directions request failed with status: ${response.data.status}`);
            return null;
        } catch (error) {
            console.error('Error getting directions:', error);
            return null;
        }
    }

    async searchNearbyPlaces(
        location: string,
        radius: number = 1000,
        type?: string,
        keyword?: string
    ): Promise<PlaceResult[] | null> {
        try {
            // Валидация радиуса (0 < radius <= 50000)
            if (radius <= 0 || radius > 50000) {
                devLog(`Invalid radius value: ${radius}. Using default 1000m.`);
                radius = 1000;
            }

            // Если location передан как адрес, а не координаты, сначала геокодируем его
            let locationParam = location;

            // Проверяем, является ли location координатами в формате "lat,lng"
            if (!this.isValidCoordinatesFormat(location)) {
                devLog(`Location "${location}" not in coordinates format, geocoding...`);
                const geocoded = await this.geocodeAddress(location);
                if (geocoded && geocoded.geometry && geocoded.geometry.location) {
                    const { lat, lng } = geocoded.geometry.location;
                    locationParam = `${lat},${lng}`;
                    devLog(`Geocoded location: ${locationParam}`);
                } else {
                    devLog(`Failed to geocode location: ${location}`);
                    return null;
                }
            }

            devLog(`Performing nearby search with params:`, {
                location: locationParam,
                radius,
                type: type || 'none',
                keyword: keyword || 'none'
            });

            const response = await axios.get(`${this.baseUrl}/place/nearbysearch/json`, {
                params: {
                    location: locationParam,
                    radius,
                    ...(type && { type }),
                    ...(keyword && { keyword }),
                    key: this.apiKey,
                    language: 'ru'
                }
            });

            if (response.data.status === 'OK') {
                devLog(`Found ${response.data.results.length} places`);
                return response.data.results as PlaceResult[];
            }

            devLog(`Nearby search failed with status: ${response.data.status}`);
            if (response.data.error_message) {
                devLog(`Error message: ${response.data.error_message}`);
            }
            return null;
        } catch (error) {
            console.error('Error searching nearby places:', error);
            return null;
        }
    }

    /**
     * Проверяет корректность формата координат
     * @param coords Строка с координатами в формате "lat,lng"
     * @returns true если формат корректный, иначе false
     */
    private isValidCoordinatesFormat(coords: string): boolean {
        // Проверка формата "lat,lng" без пробелов
        const pattern = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
        if (!pattern.test(coords)) {
            return false;
        }

        // Проверка диапазонов значений
        const [lat, lng] = coords.split(',').map(Number);
        return (
            !isNaN(lat) &&
            !isNaN(lng) &&
            lat >= -90 &&
            lat <= 90 &&
            lng >= -180 &&
            lng <= 180
        );
    }

    /**
     * Получение статической карты для указанного места
     * @param center Центр карты (адрес или координаты)
     * @param zoom Уровень масштабирования (0-21)
     * @param size Размер изображения (maxWidth=640, maxHeight=640)
     * @param markers Маркеры для отображения на карте
     * @returns URL статической карты
     */
    getStaticMapUrl(
        center: string,
        zoom: number = 14,
        size: string = '600x400',
        markers?: string[]
    ): string {
        const params = new URLSearchParams({
            center,
            zoom: zoom.toString(),
            size,
            key: this.apiKey,
            language: 'ru',
            scale: '2'  // Для лучшего качества на устройствах с высоким DPI
        });

        // Добавляем маркеры, если они есть
        if (markers && markers.length > 0) {
            markers.forEach(marker => {
                params.append('markers', marker);
            });
        }

        return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
    }

    /**
     * Форматирует инструкции маршрута в читаемый формат
     * @param directions Результат построения маршрута
     * @returns Строка с информацией о маршруте
     */
    formatDirections(directions: DirectionsResult): string {
        if (!directions.routes || directions.routes.length === 0) {
            return 'Маршрут не найден';
        }

        const route = directions.routes[0];
        const leg = route.legs[0];

        let result = `🚗 **Маршрут**: ${route.summary}\n`;
        result += `📏 **Расстояние**: ${leg.distance.text}\n`;
        result += `⏱️ **Время в пути**: ${leg.duration.text}\n\n`;

        result += "📍 **Пошаговые инструкции**:\n";

        leg.steps.forEach((step, index) => {
            // Удаляем HTML-теги из инструкций
            const instructions = step.html_instructions.replace(/<[^>]*>/g, '');
            result += `${index + 1}. ${instructions} (${step.distance.text}, ${step.duration.text})\n`;
        });

        return result;
    }

    /**
     * Форматирует результаты поиска мест в читаемый формат
     * @param places Список найденных мест
     * @returns Строка с информацией о местах
     */
    formatPlaces(places: PlaceResult[]): string {
        if (!places || places.length === 0) {
            return 'Места не найдены';
        }

        let result = `🔍 **Найдено мест**: ${places.length}\n\n`;

        places.slice(0, 5).forEach((place, index) => {
            result += `${index + 1}. **${place.name}**\n`;

            // Адрес (используем vicinity если нет formatted_address)
            if (place.formatted_address) {
                result += `   📍 Адрес: ${place.formatted_address}\n`;
            } else if (place.vicinity) {
                result += `   📍 Район: ${place.vicinity}\n`;
            }

            // Рейтинг и количество отзывов
            if (place.rating) {
                const ratingStars = '⭐'.repeat(Math.floor(place.rating)) + (place.rating % 1 >= 0.5 ? '✨' : '');
                result += `   ${ratingStars} Рейтинг: ${place.rating.toFixed(1)}`;

                if (place.user_ratings_total) {
                    result += ` (${place.user_ratings_total} отзывов)`;
                }

                result += '\n';
            }

            // Время работы
            if (place.opening_hours) {
                result += `   🕒 ${place.opening_hours.open_now ? 'Открыто сейчас' : 'Закрыто'}\n`;
            }

            // Ценовая категория
            if (place.price_level !== undefined) {
                const priceLabels = ['Бюджетно', 'Недорого', 'Умеренно', 'Дорого', 'Премиум'];
                const priceLabel = priceLabels[place.price_level] || 'Неизвестная ценовая категория';
                result += `   💰 ${priceLabel} (${place.price_level + 1}/5)\n`;
            }

            // Типы места
            if (place.types && place.types.length > 0) {
                // Переводим некоторые типы на русский
                const typeTranslations: Record<string, string> = {
                    'restaurant': 'ресторан',
                    'cafe': 'кафе',
                    'bar': 'бар',
                    'food': 'еда',
                    'store': 'магазин',
                    'lodging': 'жилье',
                    'hospital': 'больница',
                    'pharmacy': 'аптека',
                    'doctor': 'врач',
                    'atm': 'банкомат',
                    'bank': 'банк'
                };

                const translatedTypes = place.types
                    .slice(0, 3)  // Ограничиваем до 3 типов
                    .map(type => typeTranslations[type] || type)
                    .join(', ');

                result += `   🏷️ ${translatedTypes}\n`;
            }

            result += '\n';
        });

        if (places.length > 5) {
            result += `... и еще ${places.length - 5} мест\n`;
        }

        return result;
    }
}