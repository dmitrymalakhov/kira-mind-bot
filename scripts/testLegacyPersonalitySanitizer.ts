import assert from "node:assert/strict";

const { hasLegacyDigitalBiography } = require("../utils/legacyPersonalitySanitizer");

assert.equal(
    hasLegacyDigitalBiography("Она училась в лицее контекста и видела сны данных."),
    true
);

assert.equal(
    hasLegacyDigitalBiography("Она работала в цифровом медиа и любит архивное кино."),
    false
);

assert.equal(
    hasLegacyDigitalBiography("Иногда разбирает архивные заметки по семейной истории."),
    false
);

assert.equal(
    hasLegacyDigitalBiography("Её биография проходит через цифровые архивы и комнаты архивов."),
    false
);

assert.equal(
    hasLegacyDigitalBiography("Она собирала цифровые архивы для вымышленного городского музея."),
    false
);

console.log("legacyPersonalitySanitizer checks passed");
