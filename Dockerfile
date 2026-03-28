# Используйте официальный образ Node.js как базовый
FROM node:23-alpine

# Установите зависимости для компиляции нативных модулей
RUN apk add --no-cache python3 make g++ gcc

# Установите рабочую директорию в контейнере
WORKDIR /usr/src/app

# Укажите аргумент сборки для среды, значение по умолчанию - 'production'
ARG NODE_ENV=production

# Установите переменную окружения NODE_ENV
ENV NODE_ENV=${NODE_ENV}

# Копируйте файлы package.json и package-lock.json
COPY package*.json ./

# Установите зависимости проекта
RUN npm install

# Копируйте исходный код проекта в контейнер
COPY . .

# Откройте порт, который будет использоваться приложением
EXPOSE 3011

# Запуск приложения
CMD ["npm", "start"]