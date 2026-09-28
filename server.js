const express = require('express');
const axios = require('axios');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const MS_TOKEN = '562d927aad09e55f49bed5ebd3751c7ccfd19a23';


if (!MS_TOKEN) {
    console.warn('⚠️ MS_TOKEN не задан.');
    console.warn('PowerShell: $env:MS_TOKEN="ТВОЙ_ТОКЕН"');
}

const BASE = 'https://api.moysklad.ru/api/remap/1.2';

const TECH_PROCESS_ID =
    'ff0167d9-a06b-11f1-0a80-14c4000d0658';

const TECH_STORE_NAME = 'Бижутерия';

const api = axios.create({
    baseURL: BASE,
    timeout: 60000,
    headers: {
        Authorization: `Bearer ${MS_TOKEN}`,
        Accept: 'application/json;charset=utf-8',
        'Content-Type': 'application/json'
    }
});

app.use(express.json({ limit: '30mb' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// ============================================================
// RATE LIMIT
// ============================================================

let lastRequestTime = 0;

const MIN_REQUEST_INTERVAL = 500;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitRateLimit() {

    const now = Date.now();

    const wait =
        MIN_REQUEST_INTERVAL -
        (now - lastRequestTime);

    if (wait > 0) {
        await sleep(wait);
    }

    lastRequestTime = Date.now();
}


// ============================================================
// API REQUEST С RETRY 1049
// ============================================================

async function requestApi(
    method,
    url,
    data = undefined,
    options = {}
) {

    const maxRetries = 6;

    for (
        let attempt = 0;
        attempt <= maxRetries;
        attempt++
    ) {

        await waitRateLimit();

        try {

            const response =
                await api.request({
                    method,
                    url,
                    data,
                    ...options
                });

            return response;

        } catch (error) {

            const status =
                error.response?.status;

            const apiCode =
                error.response?.data
                    ?.errors?.[0]
                    ?.code;

            const isRateLimit =
                status === 429 ||
                apiCode === 1049;

            if (
                !isRateLimit ||
                attempt === maxRetries
            ) {
                throw error;
            }

            const delay =
                1000 *
                Math.pow(
                    2,
                    attempt
                );

            console.log(
                `⏳ Rate limit 1049. Повтор через ${delay} мс`
            );

            await sleep(delay);
        }
    }
}


// ============================================================
// HELPERS
// ============================================================

function idFromHref(href) {

    if (!href) return null;

    return String(href)
        .split('/')
        .pop();
}


function ref(type, id) {

    if (!id) {
        throw new Error(
            `Не указан id для ${type}`
        );
    }

    return {
        meta: {
            href:
                `${BASE}/entity/${type}/${id}`,
            type,
            mediaType:
                'application/json'
        }
    };
}


function normalize(value) {

    return String(
        value ?? ''
    )
        .trim()
        .toLowerCase();
}


function dateTime(date) {

    if (!date) {
        throw new Error(
            'Не указана дата'
        );
    }

    // МойСклад:
    // ГГГГ-ММ-ДД ЧЧ:мм:сс
    return `${date} 00:00:00`;
}


function errorData(error) {

    return (
        error.response?.data ||
        error.message
    );
}


// ============================================================
// GET ALL
// ============================================================

async function getAll(
    entity,
    params = ''
) {

    const result = [];

    let offset = 0;

    const limit = 1000;

    while (true) {

        const url =
            `/entity/${entity}` +
            `?limit=${limit}` +
            `&offset=${offset}` +
            (
                params
                    ? `&${params}`
                    : ''
            );

        const response =
            await requestApi(
                'GET',
                url
            );

        const rows =
            response.data.rows || [];

        result.push(
            ...rows
        );

        const total =
            Number(
                response.data.meta?.size ||
                0
            );

        if (
            rows.length === 0 ||
            result.length >= total
        ) {
            break;
        }

        offset += limit;
    }

    return result;
}


// ============================================================
// ГРУППЫ
// ============================================================

app.get(
    '/api/groups',
    async (req, res) => {

        try {

            const folders =
                await getAll(
                    'productfolder'
                );

            res.json({

                success: true,

                groups:
                    folders.map(
                        folder => ({

                            id:
                                folder.id,

                            name:
                                folder.name ||
                                '',

                            parentId:
                                idFromHref(
                                    folder
                                        .productFolder
                                        ?.meta
                                        ?.href
                                )

                        })
                    )

            });

        } catch (error) {

            console.error(
                'GROUP ERROR:',
                errorData(error)
            );

            res.status(500).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// ТОВАРЫ ГРУППЫ
// ============================================================

app.get(
    '/api/groups/:groupId/products',
    async (req, res) => {

        try {

            const groupId =
                req.params.groupId;

            const includeChildren =
                req.query.children !== 'false';

            const [
                folders,
                products
            ] = await Promise.all([

                getAll(
                    'productfolder'
                ),

                getAll(
                    'product'
                )

            ]);

            const allowed =
                new Set([
                    groupId
                ]);

            if (includeChildren) {

                let changed = true;

                while (changed) {

                    changed = false;

                    for (
                        const folder
                        of folders
                    ) {

                        const parentId =
                            idFromHref(
                                folder
                                    .productFolder
                                    ?.meta
                                    ?.href
                            );

                        if (
                            parentId &&
                            allowed.has(
                                parentId
                            ) &&
                            !allowed.has(
                                folder.id
                            )
                        ) {

                            allowed.add(
                                folder.id
                            );

                            changed = true;
                        }
                    }
                }
            }

            const result =
                products
                    .filter(product => {

                        const folderId =
                            idFromHref(
                                product
                                    .productFolder
                                    ?.meta
                                    ?.href
                            );

                        return allowed.has(
                            folderId
                        );

                    })
                    .map(product => ({

                        id:
                            product.id,

                        name:
                            product.name ||
                            '',

                        code:
                            product.code ||
                            '',

                        article:
                            product.article ||
                            '',

                        groupId:
                            idFromHref(
                                product
                                    .productFolder
                                    ?.meta
                                    ?.href
                            )

                    }));

            res.json({

                success: true,

                products:
                    result

            });

        } catch (error) {

            console.error(
                'GROUP PRODUCTS ERROR:',
                errorData(error)
            );

            res.status(500).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// СПРАВОЧНИКИ
// ============================================================

app.get(
    '/api/references',
    async (req, res) => {

        try {

            const [
                organizations,
                counterparties,
                stores,
                productFolders,
                planFolders
            ] = await Promise.all([

                getAll(
                    'organization'
                ),

                getAll(
                    'counterparty'
                ),

                getAll(
                    'store'
                ),

                getAll(
                    'productfolder'
                ),

                getAll(
                    'processingplanfolder'
                )

            ]);

            function sortStores(a, b) {

                const an =
                    normalize(a.name);

                const bn =
                    normalize(b.name);

                if (
                    an === 'основной'
                ) return -1;

                if (
                    bn === 'основной'
                ) return 1;

                if (
                    an === 'бижутерия'
                ) return -1;

                if (
                    bn === 'бижутерия'
                ) return 1;

                return an.localeCompare(
                    bn,
                    'ru'
                );
            }

            stores.sort(
                sortStores
            );

            res.json({

                success: true,

                organizations:
                    organizations.map(
                        x => ({
                            id:
                                x.id,
                            name:
                                x.name ||
                                ''
                        })
                    ),

                counterparties:
                    counterparties.map(
                        x => ({
                            id:
                                x.id,
                            name:
                                x.name ||
                                '',
                            code:
                                x.code ||
                                ''
                        })
                    ),

                stores:
                    stores.map(
                        x => ({
                            id:
                                x.id,
                            name:
                                x.name ||
                                ''
                        })
                    ),

                productFolders:
                    productFolders.map(
                        x => ({
                            id:
                                x.id,
                            name:
                                x.name ||
                                '',
                            parentId:
                                idFromHref(
                                    x
                                        .productFolder
                                        ?.meta
                                        ?.href
                                )
                        })
                    ),

                planFolders:
                    planFolders.map(
                        x => ({
                            id:
                                x.id,
                            name:
                                x.name ||
                                ''
                        })
                    )

            });

        } catch (error) {

            console.error(
                'REFERENCES ERROR:',
                errorData(error)
            );

            res.status(500).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// КАТАЛОГ
// ============================================================

app.get(
    '/api/catalog',
    async (req, res) => {

        try {

            const products =
                await getAll(
                    'product'
                );

            res.json({

                success: true,

                products:
                    products.map(
                        p => ({

                            id:
                                p.id,

                            name:
                                p.name ||
                                '',

                            code:
                                p.code ||
                                '',

                            article:
                                p.article ||
                                ''

                        })
                    )

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// ОСТАТКИ
// ============================================================

app.post(
    '/api/stock',
    async (req, res) => {

        try {

            const {
                productIds,
                storeId
            } = req.body;

            if (
                !Array.isArray(
                    productIds
                )
            ) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            'productIds должен быть массивом'

                    });
            }

            let params =
                'stockMode=all';

            if (storeId) {

                params +=
                    `&stockStore=${encodeURIComponent(
                        `${BASE}/entity/store/${storeId}`
                    )}`;

            }

            const assortment =
                await getAll(
                    'assortment',
                    params
                );

            const wanted =
                new Set(
                    productIds
                );

            const stock = {};

            for (
                const item
                of assortment
            ) {

                if (
                    !wanted.has(
                        item.id
                    )
                ) {
                    continue;
                }

                stock[item.id] =
                    Number(
                        item.stock ||
                        0
                    );
            }

            res.json({

                success: true,

                stock

            });

        } catch (error) {

            console.error(
                'STOCK ERROR:',
                errorData(error)
            );

            res.status(500).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);



// ============================================================
// ЗАГРУЗКА EXCEL ПО КОЛОНКЕ «АРТИКУЛ ПОСТАВЩИКА»
// ============================================================
//
// Остальные столбцы Excel не имеют значения.
// Обязателен только заголовок:
// «Артикул поставщика».
//
// Если найден столбец количества, он используется.
// Иначе количество = 1.
//
// Товары ищутся по полям product.article («Артикул») и product.code («Код товара») в МойСклад.
// ============================================================

function normalizeExcelHeader(value) {

    return String(value ?? '')
        .replace(/\u00A0/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();

}


function normalizeSupplierArticle(value) {

    if (
        value === null ||
        value === undefined
    ) {
        return '';
    }

    // Excel иногда превращает числовой артикул в 12345.0
    if (
        typeof value === 'number' &&
        Number.isInteger(value)
    ) {
        return String(value);
    }

    return String(value)
        .trim()
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase();

}


function findExcelColumn(headers, variants) {

    const wanted =
        new Set(
            variants.map(
                normalizeExcelHeader
            )
        );

    return headers.findIndex(
        header =>
            wanted.has(
                normalizeExcelHeader(header)
            )
    );

}


function parseExcelQuantity(value) {

    if (
        value === null ||
        value === undefined ||
        String(value).trim() === ''
    ) {
        return 1;
    }

    const number =
        Number(
            String(value)
                .replace(/\s/g, '')
                .replace(',', '.')
        );

    if (
        !Number.isFinite(number) ||
        number <= 0
    ) {
        return 1;
    }

    return Math.max(
        1,
        Math.round(number)
    );

}


app.post(
    '/api/import-excel',
    async (req, res) => {

        try {

            const base64 =
                req.body?.file;

            if (!base64) {

                return res.status(400).json({

                    success: false,

                    error:
                        'Excel-файл не передан'

                });

            }

            const buffer =
                Buffer.from(
                    String(base64).replace(
                        /^data:.*?;base64,/,
                        ''
                    ),
                    'base64'
                );

            if (!buffer.length) {

                return res.status(400).json({

                    success: false,

                    error:
                        'Excel-файл пустой'

                });

            }

            const workbook =
                XLSX.read(
                    buffer,
                    {
                        type: 'buffer',
                        cellDates: false,
                        raw: true
                    }
                );

            if (
                !workbook.SheetNames.length
            ) {

                throw new Error(
                    'В Excel нет листов'
                );

            }

            // Ищем первый лист, в котором есть
            // обязательный столбец «Артикул поставщика».
            let selectedSheet = null;
            let rows = [];
            let headers = [];
            let articleColumn = -1;
            let quantityColumn = -1;

            for (
                const sheetName
                of workbook.SheetNames
            ) {

                const sheet =
                    workbook.Sheets[
                        sheetName
                    ];

                const matrix =
                    XLSX.utils.sheet_to_json(
                        sheet,
                        {
                            header: 1,
                            defval: '',
                            raw: true
                        }
                    );

                if (!matrix.length) {
                    continue;
                }

                const sheetHeaders =
                    matrix[0] || [];

                const foundArticleColumn =
                    findExcelColumn(
                        sheetHeaders,
                        [
                            'Артикул поставщика'
                        ]
                    );

                if (
                    foundArticleColumn >= 0
                ) {

                    selectedSheet =
                        sheetName;

                    headers =
                        sheetHeaders;

                    articleColumn =
                        foundArticleColumn;

                    quantityColumn =
                        findExcelColumn(
                            sheetHeaders,
                            [
                                'Количество, шт',
                                'Количество',
                                'Кол-во, шт',
                                'Кол-во',
                                'Кол.',
                                'Qty',
                                'Quantity'
                            ]
                        );

                    rows =
                        matrix.slice(1);

                    break;
                }

            }

            if (
                articleColumn < 0
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        'Не найден обязательный столбец «Артикул поставщика».'

                });

            }

            const imported = [];
            const emptyRows = [];

            for (
                let i = 0;
                i < rows.length;
                i++
            ) {

                const row =
                    rows[i] || [];

                const rawArticle =
                    row[articleColumn];

                const article =
                    String(
                        rawArticle ?? ''
                    ).trim();

                if (!article) {

                    emptyRows.push(
                        i + 2
                    );

                    continue;
                }

                imported.push({

                    row:
                        i + 2,

                    article,

                    // Для Excel всегда ищем товар с суффиксом -z.
                    // Если в Excel уже указано -z, второй раз его не добавляем.
                    normalizedArticle:
                        normalizeSupplierArticle(
                            /-z$/i.test(article)
                                ? article
                                : `${article}-z`
                        ),

                    quantity:
                        quantityColumn >= 0
                            ? parseExcelQuantity(
                                row[
                                    quantityColumn
                                ]
                            )
                            : 1

                });

            }

            const products =
                await getAll(
                    'product'
                );

            // «Артикул поставщика» из Excel сопоставляем сразу
            // с двумя полями карточки МойСклад:
            // Артикул (product.article) И Код товара (product.code).
            const byArticle = new Map();
            const byCode = new Map();

            function addToIndex(map, key, product) {
                if (!key) return;
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(product);
            }

            for (const product of products) {
                addToIndex(
                    byArticle,
                    normalizeSupplierArticle(product.article),
                    product
                );

                addToIndex(
                    byCode,
                    normalizeSupplierArticle(product.code),
                    product
                );
            }

            const matched = [];
            const notFound = [];
            const duplicates = [];

            for (
                const item
                of imported
            ) {

                const articleMatches =
                    byArticle.get(item.normalizedArticle) || [];

                const codeMatches =
                    byCode.get(item.normalizedArticle) || [];

                // Объединяем совпадения по Артикулу и Коду,
                // чтобы одна карточка не попала дважды.
                const foundMap = new Map();

                for (const product of articleMatches) {
                    foundMap.set(product.id, {
                        product,
                        matchedBy: 'Артикул'
                    });
                }

                for (const product of codeMatches) {
                    if (foundMap.has(product.id)) {
                        foundMap.get(product.id).matchedBy =
                            'Артикул и Код товара';
                    } else {
                        foundMap.set(product.id, {
                            product,
                            matchedBy: 'Код товара'
                        });
                    }
                }

                const found = [...foundMap.values()];

                if (!found.length) {
                    notFound.push({
                        row: item.row,
                        article: item.article
                    });
                    continue;
                }

                // Если один Excel-артикул соответствует нескольким
                // карточкам — не выбираем случайную карточку.
                if (found.length > 1) {
                    duplicates.push({
                        row: item.row,
                        article: item.article,
                        products: found.map(match => ({
                            id: match.product.id,
                            name: match.product.name || '',
                            code: match.product.code || '',
                            article: match.product.article || '',
                            matchedBy: match.matchedBy
                        }))
                    });
                    continue;
                }

                const product = found[0].product;

                matched.push({

                    row:
                        item.row,

                    article:
                        item.article,

                    matchedBy:
                        found[0].matchedBy,

                    quantity:
                        item.quantity,

                    product: {

                        id:
                            product.id,

                        name:
                            product.name || '',

                        code:
                            product.code || '',

                        article:
                            product.article || '',

                        groupId:
                            idFromHref(
                                product
                                    .productFolder
                                    ?.meta
                                    ?.href
                            )

                    }

                });

            }

            res.json({

                success: true,

                sheet:
                    selectedSheet,

                articleColumn:
                    headers[articleColumn],

                quantityColumn:
                    quantityColumn >= 0
                        ? headers[quantityColumn]
                        : null,

                totalRows:
                    imported.length,

                matched,

                notFound,

                duplicates,

                emptyRows

            });

        } catch (error) {

            console.error(
                'EXCEL IMPORT ERROR:',
                errorData(error)
            );

            res.status(
                500
            ).json({

                success: false,

                error:
                    errorData(error)

            });

        }

    }
);


// ============================================================
// ПРОВЕРКА ТОВАРОВ БЕЗ -Z
// ============================================================

app.post(
    '/api/check-target-products',
    async (req, res) => {

        try {

            const items =
                req.body.items || [];

            const products =
                await getAll(
                    'product'
                );

            const byId =
                new Map(
                    products.map(
                        p => [
                            p.id,
                            p
                        ]
                    )
                );

            const byCode =
                new Map();

            for (
                const product
                of products
            ) {

                if (
                    product.code
                ) {

                    byCode.set(
                        normalize(
                            product.code
                        ),
                        product
                    );

                }
            }

            const result = [];

            for (
                const item
                of items
            ) {

                const source =
                    byId.get(
                        item.productId
                    );

                if (!source) {

                    result.push({

                        productId:
                            item.productId,

                        quantity:
                            Number(
                                item.quantity ||
                                0
                            ),

                        error:
                            'Товар не найден'

                    });

                    continue;
                }

                const sourceCode =
                    String(
                        source.code ||
                        ''
                    ).trim();

                const targetCode =
                    /-z$/i.test(
                        sourceCode
                    )
                        ? sourceCode.slice(
                            0,
                            -2
                        )
                        : sourceCode;

                const target =
                    byCode.get(
                        normalize(
                            targetCode
                        )
                    );

                result.push({

                    sourceId:
                        source.id,

                    sourceName:
                        source.name ||
                        '',

                    sourceCode,

                    targetId:
                        target?.id ||
                        null,

                    targetName:
                        target?.name ||
                        null,

                    targetCode,

                    quantity:
                        Number(
                            item.quantity ||
                            0
                        )

                });
            }

            res.json({

                success: true,

                items:
                    result

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// ПОЛНОЕ КОПИРОВАНИЕ КАРТОЧКИ ТОВАРА БЕЗ -Z
// ============================================================
//
// Логика:
//
// 1. Находим исходную карточку XXX-Z
// 2. Получаем ПОЛНУЮ карточку отдельным GET
// 3. Берём все данные карточки
// 4. Убираем только системные / вычисляемые поля
// 5. Меняем ТОЛЬКО code: XXX-Z -> XXX
// 6. Создаём новую карточку
// 7. Копируем все изображения
// 8. Копируем все файлы
//
// Остальные данные карточки:
// - название
// - артикул
// - описание
// - группа
// - единица измерения
// - НДС
// - штрихкоды
// - цены
// - упаковки
// - доп. поля
// - характеристики
// - вес
// - объём
// - поставщик
// - страна
// - маркировка
// - и остальные передаваемые поля
//
// копируются автоматически.
//
// НЕ копируются:
// - id
// - meta
// - accountId
// - created
// - updated
// - owner
// - externalCode
// - остатки
// - резервы
//
// ============================================================


// ============================================================
// ПОЛУЧЕНИЕ ПОЛНОЙ КАРТОЧКИ ТОВАРА
// ============================================================

async function getFullProduct(productId) {

    const response =
        await requestApi(
            'GET',
            `/entity/product/${productId}`
        );

    return response.data;
}


// ============================================================
// ПОЛУЧЕНИЕ ВСЕХ ИЗОБРАЖЕНИЙ ТОВАРА
// ============================================================

async function getProductImages(productId) {

    const response =
        await requestApi(
            'GET',
            `/entity/product/${productId}/images?limit=1000`
        );

    return response.data?.rows || [];
}


// ============================================================
// ПОЛУЧЕНИЕ ВСЕХ ФАЙЛОВ ТОВАРА
// ============================================================

async function getProductFiles(productId) {

    const response =
        await requestApi(
            'GET',
            `/entity/product/${productId}/files?limit=1000`
        );

    return response.data?.rows || [];
}


// ============================================================
// ПОЛУЧЕНИЕ СОДЕРЖИМОГО ФАЙЛА / ИЗОБРАЖЕНИЯ
// ============================================================
//
// У разных объектов МойСклад ссылка на скачивание может
// находиться в downloadHref / downloadhref / href.
//
// Поэтому проверяем несколько вариантов.
// ============================================================

function getDownloadHref(entity) {

    return (
        entity?.meta?.downloadHref ||
        entity?.meta?.downloadhref ||
        entity?.downloadHref ||
        entity?.downloadhref ||
        entity?.meta?.href ||
        null
    );
}


// ============================================================
// ПОДГОТОВКА ПОЛНОЙ КОПИИ КАРТОЧКИ
// ============================================================

function prepareProductCopy(
    source,
    targetCode
) {

    const payload = {};


    // --------------------------------------------------------
    // Поля, которые принадлежат СТАРОЙ карточке
    // и не должны переходить в новую.
    // --------------------------------------------------------

    const excludedFields =
        new Set([

            // ID товара
            'id',

            // Метаданные старого товара
            'meta',

            // Аккаунт
            'accountId',

            // Системные даты
            'created',
            'updated',

            // Внешний системный идентификатор
            'externalCode',

            // Владелец
            'owner',

            // Служебный sync ID
            'syncID',

            // Остатки
            'stock',

            // Резерв
            'reserve',

            // Неснижаемый остаток
            'minimumStock',

            // Вычисляемые значения
            'stockDays',

            // Некоторые служебные поля,
            // которые могут присутствовать в расширенном ответе
            'discountProhibited',

            // Не копируем готовую ссылку на изображения.
            // Изображения копируются отдельно.
            'image',
            'images',

            // Файлы тоже копируются отдельно.
            'files'

        ]);


    // --------------------------------------------------------
    // КОПИРУЕМ ВСЕ ОСТАЛЬНЫЕ ПОЛЯ
    // --------------------------------------------------------

    for (
        const [key, value]
        of Object.entries(source)
    ) {

        if (
            excludedFields.has(key)
        ) {
            continue;
        }


        if (
            value === undefined
        ) {
            continue;
        }


        payload[key] = value;
    }


    // --------------------------------------------------------
    // ЕДИНСТВЕННОЕ ИЗМЕНЯЕМОЕ ПОЛЕ
    // --------------------------------------------------------

    payload.code =
        targetCode;


    return payload;
}



// ============================================================
// КОПИРОВАНИЕ ИЗОБРАЖЕНИЙ
// ============================================================

async function copyProductImages(
    sourceProductId,
    targetProductId
) {

    console.log('');
    console.log(
        '--------------------------------------------------'
    );

    console.log(
        `🖼 Копирование изображений: ${sourceProductId} -> ${targetProductId}`
    );


    const images =
        await getProductImages(
            sourceProductId
        );


    console.log(
        `🖼 Найдено изображений: ${images.length}`
    );


    const result = {

        copied: 0,

        errors: []

    };


    if (!images.length) {

        console.log(
            '🖼 Изображений нет'
        );

        return result;
    }


    // --------------------------------------------------------
    // В МойСклад разрешено максимум 10 изображений товара.
    // --------------------------------------------------------

    const imagesToCopy =
        images.slice(
            0,
            10
        );


    if (
        images.length > 10
    ) {

        console.log(
            `⚠️ Найдено ${images.length} изображений. ` +
            `МойСклад позволяет максимум 10. ` +
            `Будут скопированы первые 10.`
        );

    }


    // --------------------------------------------------------
    // Каждое изображение отдельно
    // --------------------------------------------------------

    for (
        let i = 0;
        i < imagesToCopy.length;
        i++
    ) {

        const image =
            imagesToCopy[i];


        try {

            const downloadHref =
                getDownloadHref(
                    image
                );


            if (!downloadHref) {

                throw new Error(
                    'Не найдена ссылка для скачивания изображения'
                );

            }


            console.log(
                `🖼 [${i + 1}/${imagesToCopy.length}] ` +
                `Получаем изображение`
            );


            // ------------------------------------------------
            // Получаем бинарное содержимое
            // ------------------------------------------------

            const response =
                await requestApi(
                    'GET',
                    downloadHref,
                    undefined,
                    {
                        responseType:
                            'arraybuffer'
                    }
                );


            const buffer =
                Buffer.from(
                    response.data
                );


            const content =
                buffer.toString(
                    'base64'
                );


            // ------------------------------------------------
            // Определяем имя файла
            // ------------------------------------------------

            let filename =
                image.filename ||
                image.name ||
                `image-${i + 1}.jpg`;


            // Если имя без расширения,
            // попробуем определить формат по Content-Type.
            if (
                !/\.[a-z0-9]{2,5}$/i.test(
                    filename
                )
            ) {

                const contentType =
                    response.headers?.[
                        'content-type'
                    ];


                if (
                    contentType ===
                    'image/png'
                ) {

                    filename +=
                        '.png';

                } else {

                    filename +=
                        '.jpg';

                }

            }


            // ------------------------------------------------
            // Загружаем изображение в новую карточку
            // ------------------------------------------------

            await requestApi(
                'POST',
                `/entity/product/${targetProductId}/images`,
                {
                    filename,
                    content
                }
            );


            result.copied++;


            console.log(
                `✅ Изображение ${i + 1} скопировано: ${filename}`
            );


        } catch (error) {

            console.error(
                `❌ Ошибка изображения ${i + 1}:`,
                errorData(error)
            );


            result.errors.push({

                index:
                    i + 1,

                filename:
                    image?.filename ||
                    image?.name ||
                    null,

                error:
                    errorData(error)

            });

        }

    }


    return result;
}


// ============================================================
// КОПИРОВАНИЕ ФАЙЛОВ
// ============================================================
//
// Это не изображения.
// Если в карточке есть прикреплённые файлы,
// они также копируются отдельно.
//
// API МойСклад позволяет добавлять до 10 файлов
// одним запросом.
// ============================================================

async function copyProductFiles(
    sourceProductId,
    targetProductId
) {

    console.log('');
    console.log(
        '--------------------------------------------------'
    );

    console.log(
        `📎 Копирование файлов: ${sourceProductId} -> ${targetProductId}`
    );


    const files =
        await getProductFiles(
            sourceProductId
        );


    console.log(
        `📎 Найдено файлов: ${files.length}`
    );


    const result = {

        copied: 0,

        errors: []

    };


    if (!files.length) {

        console.log(
            '📎 Файлов нет'
        );

        return result;
    }


    // --------------------------------------------------------
    // Собираем файлы пачками по 10
    // --------------------------------------------------------

    for (
        let start = 0;
        start < files.length;
        start += 10
    ) {

        const batch =
            files.slice(
                start,
                start + 10
            );


        const upload =
            [];


        // ----------------------------------------------------
        // Получаем содержимое каждого файла
        // ----------------------------------------------------

        for (
            let i = 0;
            i < batch.length;
            i++
        ) {

            const file =
                batch[i];


            try {

                const downloadHref =
                    getDownloadHref(
                        file
                    );


                if (!downloadHref) {

                    throw new Error(
                        'Не найдена ссылка для скачивания файла'
                    );

                }


                console.log(
                    `📎 Получаем файл ${start + i + 1}/${files.length}`
                );


                const response =
                    await requestApi(
                        'GET',
                        downloadHref,
                        undefined,
                        {
                            responseType:
                                'arraybuffer'
                        }
                    );


                const buffer =
                    Buffer.from(
                        response.data
                    );


                const content =
                    buffer.toString(
                        'base64'
                    );


                const filename =
                    file.filename ||
                    file.name ||
                    `file-${start + i + 1}`;


                upload.push({

                    filename,

                    content

                });


            } catch (error) {

                console.error(
                    `❌ Ошибка получения файла ${start + i + 1}:`,
                    errorData(error)
                );


                result.errors.push({

                    index:
                        start + i + 1,

                    filename:
                        file?.filename ||
                        file?.name ||
                        null,

                    error:
                        errorData(error)

                });

            }

        }


        // ----------------------------------------------------
        // Загружаем пачку
        // ----------------------------------------------------

        if (!upload.length) {
            continue;
        }


        try {

            await requestApi(
                'POST',
                `/entity/product/${targetProductId}/files`,
                upload
            );


            result.copied +=
                upload.length;


            console.log(
                `✅ Загружено файлов: ${upload.length}`
            );


        } catch (error) {

            console.error(
                '❌ Ошибка загрузки файлов:',
                errorData(error)
            );


            for (
                const file
                of upload
            ) {

                result.errors.push({

                    filename:
                        file.filename,

                    error:
                        errorData(error)

                });

            }

        }

    }


    return result;
}


// ============================================================
// СОЗДАНИЕ НЕДОСТАЮЩИХ ТОВАРОВ
// ============================================================

app.post(
    '/api/create-missing-products',
    async (req, res) => {

        try {

            const {
                items,
                folderId
            } = req.body;


            if (
                !Array.isArray(items)
            ) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            'items должен быть массивом'

                    });

            }


            // ------------------------------------------------
            // Получаем список товаров
            // ------------------------------------------------

            const products =
                await getAll(
                    'product'
                );


            // ------------------------------------------------
            // Индекс по ID
            // ------------------------------------------------

            const byId =
                new Map(
                    products.map(
                        p => [
                            p.id,
                            p
                        ]
                    )
                );


            // ------------------------------------------------
            // Индекс по коду
            // ------------------------------------------------

            const byCode =
                new Map();


            products.forEach(
                product => {

                    if (
                        product.code
                    ) {

                        byCode.set(
                            normalize(
                                product.code
                            ),
                            product
                        );

                    }

                }
            );


            const created =
                [];

            const errors =
                [];


            // =================================================
            // ОБРАБАТЫВАЕМ ТОВАРЫ ПО ОДНОМУ
            // =================================================

            for (
                const item
                of items || []
            ) {

                try {

                    // ------------------------------------------------
                    // Находим исходный товар
                    // ------------------------------------------------

                    const sourceShort =
                        byId.get(
                            item.sourceId
                        );


                    if (!sourceShort) {

                        errors.push({

                            code:
                                item.targetCode,

                            error:
                                'Исходная карточка не найдена'

                        });

                        continue;
                    }


                    // ------------------------------------------------
                    // Получаем ПОЛНУЮ карточку
                    // ------------------------------------------------

                    console.log('');
                    console.log(
                        '=================================================='
                    );

                    console.log(
                        `📦 ПОЛНОЕ КОПИРОВАНИЕ: ${sourceShort.code}`
                    );


                    const source =
                        await getFullProduct(
                            sourceShort.id
                        );


                    // ------------------------------------------------
                    // Проверяем исходный код
                    // ------------------------------------------------

                    const sourceCode =
                        String(
                            source.code ||
                            sourceShort.code ||
                            ''
                        ).trim();


                    // ------------------------------------------------
                    // Новый код
                    // XXX-Z -> XXX
                    // ------------------------------------------------

                    const targetCode =
                        /-z$/i.test(
                            sourceCode
                        )
                            ? sourceCode.slice(
                                0,
                                -2
                            )
                            : sourceCode;


                    if (!targetCode) {

                        throw new Error(
                            'Не удалось определить новый код'
                        );

                    }


                    console.log(
                        `Старый код: ${sourceCode}`
                    );

                    console.log(
                        `Новый код: ${targetCode}`
                    );


                    // ------------------------------------------------
                    // Проверяем, существует ли уже такой товар
                    // ------------------------------------------------

                    const exists =
                        byCode.get(
                            normalize(
                                targetCode
                            )
                        );


                    if (exists) {

                        console.log(
                            `ℹ️ Товар ${targetCode} уже существует`
                        );


                        created.push({

                            id:
                                exists.id,

                            code:
                                exists.code,

                            name:
                                exists.name,

                            alreadyExists:
                                true,

                            imagesCopied:
                                0,

                            filesCopied:
                                0,

                            barcodesCopied:
                                0,

                            barcodes:
                                extractProductBarcodes(
                                    exists
                                )

                        });


                        continue;
                    }


                    // =================================================
                    // ПОДГОТАВЛИВАЕМ ПОЛНУЮ КОПИЮ
                    // =================================================

                    const payload =
                        prepareProductCopy(
                            source,
                            targetCode
                        );


                    // ------------------------------------------------
                    // ВАЖНО:
                    //
                    // Если folderId передан старым интерфейсом,
                    // используем его.
                    //
                    // Если folderId НЕ передан,
                    // productFolder уже был скопирован
                    // из исходной карточки.
                    // ------------------------------------------------

                    if (
                        folderId
                    ) {

                        payload.productFolder =
                            ref(
                                'productfolder',
                                folderId
                            );

                    }


                    console.log('');
                    console.log(
                        `📝 Создаём новую карточку ${targetCode}`
                    );


                    console.log(
                        `📋 Передаём полей: ${
                            Object.keys(
                                payload
                            ).length
                        }`
                    );


                    // ------------------------------------------------
                    // Для отладки можно посмотреть поля
                    // ------------------------------------------------

                    console.log(
                        '📋 Поля копии:',
                        Object.keys(
                            payload
                        ).join(', ')
                    );


                    // =================================================
                    // СОЗДАЁМ НОВУЮ КАРТОЧКУ
                    // =================================================

                    const response =
                        await requestApi(
                            'POST',
                            '/entity/product',
                            payload
                        );


                    const product =
                        response.data;


                    if (
                        !product?.id
                    ) {

                        throw new Error(
                            'МойСклад не вернул ID созданного товара'
                        );

                    }


                    console.log(
                        `✅ Карточка создана: ${product.id}`
                    );


                    // =================================================
                                        // =================================================

                    const barcodeResult =
                        await copyProductBarcodes(
                            source,
                            product
                        );


                    // ------------------------------------------------
                    // Добавляем в индекс
                    // ------------------------------------------------

                    byCode.set(
                        normalize(
                            product.code
                        ),
                        product
                    );


                    byId.set(
                        product.id,
                        product
                    );


                    // =================================================
                    // КОПИРУЕМ ИЗОБРАЖЕНИЯ
                    // =================================================

                    let imageResult = {

                        copied: 0,

                        errors: []

                    };


                    try {

                        imageResult =
                            await copyProductImages(
                                source.id,
                                product.id
                            );


                    } catch (error) {

                        console.error(
                            '❌ Ошибка блока копирования изображений:',
                            errorData(error)
                        );


                        imageResult.errors.push({

                            error:
                                errorData(error)

                        });

                    }


                    // =================================================
                    // КОПИРУЕМ ФАЙЛЫ
                    // =================================================

                    let fileResult = {

                        copied: 0,

                        errors: []

                    };


                    try {

                        fileResult =
                            await copyProductFiles(
                                source.id,
                                product.id
                            );


                    } catch (error) {

                        console.error(
                            '❌ Ошибка блока копирования файлов:',
                            errorData(error)
                        );


                        fileResult.errors.push({

                            error:
                                errorData(error)

                        });

                    }


                    // =================================================
                    // ФИНАЛЬНЫЙ РЕЗУЛЬТАТ
                    // =================================================

                    created.push({

                        id:
                            product.id,

                        code:
                            product.code,

                        name:
                            product.name,

                        alreadyExists:
                            false,

                        barcodesCopied:
                            barcodeResult.copied,

                        barcodes:
                            barcodeResult.barcodes,

                        barcodeError:
                            barcodeResult.error,

                        // ---------------------------------------------
                        // Сколько изображений скопировано
                        // ---------------------------------------------

                        imagesCopied:
                            imageResult.copied,

                        imageErrors:
                            imageResult.errors,

                        // ---------------------------------------------
                        // Сколько файлов скопировано
                        // ---------------------------------------------

                        filesCopied:
                            fileResult.copied,

                        fileErrors:
                            fileResult.errors

                    });


                    console.log('');
                    console.log(
                        `✅ ГОТОВО: ${sourceCode} -> ${targetCode}`
                    );

                    console.log(
                        `🖼 Изображений: ${imageResult.copied}`
                    );

                    console.log(
                        `📎 Файлов: ${fileResult.copied}`
                    );


                } catch (error) {

                    console.error(
                        `❌ ОШИБКА СОЗДАНИЯ ${item.targetCode}:`,
                        errorData(error)
                    );


                    errors.push({

                        code:
                            item.targetCode,

                        error:
                            errorData(error)

                    });

                }

            }


            // =================================================
            // ОТВЕТ
            // =================================================

            res.json({

                success:
                    errors.length === 0,

                created,

                errors

            });


        } catch (error) {

            console.error(
                'CREATE MISSING PRODUCTS ERROR:',
                errorData(error)
            );


            res.status(
                error.response?.status ||
                500
            ).json({

                success: false,

                error:
                    errorData(error)

            });

        }

    }
);


// ============================================================
// ТЕХКАРТЫ
// ============================================================

async function getPlanMaterials(
    planId
) {

    const response =
        await requestApi(
            'GET',
            `/entity/processingplan/${planId}/materials?limit=1000`
        );

    return (
        response.data.rows ||
        []
    );
}


async function getPlanProducts(
    planId
) {

    const response =
        await requestApi(
            'GET',
            `/entity/processingplan/${planId}/products?limit=1000`
        );

    return (
        response.data.rows ||
        []
    );
}


async function getPlan(
    planId
) {

    const response =
        await requestApi(
            'GET',
            `/entity/processingplan/${planId}`
        );

    return response.data;
}


async function findPlanByName(
    name
) {

    const plans =
        await getAll(
            'processingplan'
        );

    return (
        plans.find(
            p =>
                normalize(
                    p.name
                ) ===
                normalize(name)
        ) ||
        null
    );
}


// ============================================================
// СОЗДАНИЕ ТЕХКАРТЫ
// ============================================================

async function createPlan({
    product,
    sourceMaterial,
    planFolderId,
    extraMaterials
}) {

    const payload = {

        name:
            product.code,

        products: [

            {

                assortment:
                    ref(
                        'product',
                        product.id
                    ),

                quantity: 1

            }

        ]

    };

    if (planFolderId) {

        payload.parent =
            ref(
                'processingplanfolder',
                planFolderId
            );

    }

    payload.processingProcess =
        ref(
            'processingprocess',
            TECH_PROCESS_ID
        );

    console.log(
        `Создание техкарты: ${product.code}`
    );

    const response =
        await requestApi(
            'POST',
            '/entity/processingplan',
            payload
        );

    const plan =
        response.data;

    await requestApi(
        'POST',
        `/entity/processingplan/${plan.id}/materials`,
        {

            assortment:
                ref(
                    'product',
                    sourceMaterial.id
                ),

            quantity: 1

        }
    );

    for (
        const material
        of extraMaterials || []
    ) {

        if (!material?.id) {
            continue;
        }

        await requestApi(
            'POST',
            `/entity/processingplan/${plan.id}/materials`,
            {

                assortment:
                    ref(
                        'product',
                        material.id
                    ),

                quantity: 1

            }
        );
    }

    return plan;
}


// ============================================================
// ОБНОВЛЕНИЕ ОДНОЙ КОНКРЕТНОЙ ТЕХКАРТЫ
// ============================================================

async function updateSelectedPlan({
    plan,
    sourceMaterial,
    extraMaterials
}) {

    if (!plan?.id) {
        throw new Error(
            'Не удалось определить ID техкарты'
        );
    }

    const current =
        await getPlan(
            plan.id
        );

    const planName =
        current?.name ||
        plan?.name ||
        '';

    console.log(
        `Проверяем только техкарту: ${planName}`
    );

    // --------------------------------------------------------
    // ТЕХПРОЦЕСС
    // --------------------------------------------------------

    if (
        normalize(
            idFromHref(
                current
                    .processingProcess
                    ?.meta
                    ?.href
            )
        ) !==
        normalize(
            TECH_PROCESS_ID
        )
    ) {

        console.log(
            `Устанавливаем техпроцесс для карты ${planName}`
        );

        await requestApi(
            'PUT',
            `/entity/processingplan/${plan.id}`,
            {

                processingProcess:
                    ref(
                        'processingprocess',
                        TECH_PROCESS_ID
                    )

            }
        );

    }

    // --------------------------------------------------------
    // ЧИТАЕМ МАТЕРИАЛЫ ТОЛЬКО ЭТОЙ КАРТЫ
    // --------------------------------------------------------

    const materials =
        await getPlanMaterials(
            plan.id
        );

    const sourceCode =
        normalize(
            sourceMaterial.code
        );

    const extraCodes =
        new Set(
            (extraMaterials || [])
                .map(
                    x =>
                        normalize(
                            x.code
                        )
                )
        );

    // Удаляем только старые материалы,
    // которые входят в текущий комплект.
    //
    // Главное:
    // никаких проверок других техкарт.

    for (
        const material
        of materials
    ) {

        const code =
            normalize(
                material
                    .assortment
                    ?.meta
                    ?.href
            );

        let productCode = '';

        try {

            const href =
                material
                    .assortment
                    ?.meta
                    ?.href;

            if (href) {

                const product =
                    (
                        await requestApi(
                            'GET',
                            href
                        )
                    ).data;

                productCode =
                    normalize(
                        product.code
                    );

            }

        } catch {}

        if (
            productCode ===
                sourceCode ||
            extraCodes.has(
                productCode
            )
        ) {

            console.log(
                `Удаляем материал ${productCode} из ${planName}`
            );

            await requestApi(
                'DELETE',
                `/entity/processingplan/${plan.id}/materials/${material.id}`
            );

        }
    }

    // --------------------------------------------------------
    // ОСНОВНОЙ -Z
    // --------------------------------------------------------

    console.log(
        `Добавляем материал ${sourceMaterial.code} в ${planName}`
    );

    await requestApi(
        'POST',
        `/entity/processingplan/${plan.id}/materials`,
        {

            assortment:
                ref(
                    'product',
                    sourceMaterial.id
                ),

            quantity: 1

        }
    );

    // --------------------------------------------------------
    // ДОПОЛНИТЕЛЬНЫЕ
    // --------------------------------------------------------

    for (
        const material
        of extraMaterials || []
    ) {

        if (!material?.id) {
            continue;
        }

        console.log(
            `Добавляем материал ${material.code} в ${planName}`
        );

        await requestApi(
            'POST',
            `/entity/processingplan/${plan.id}/materials`,
            {

                assortment:
                    ref(
                        'product',
                        material.id
                    ),

                quantity: 1

            }
        );
    }

    return (
        await getPlan(
            plan.id
        )
    );
}


// ============================================================
// PREPARE PROCESSING
// ============================================================

app.post(
    '/api/prepare-processing',
    async (req, res) => {

        try {

            const {
                items,
                planFolderId,
                extraMaterialIds
            } = req.body;

            if (
                !Array.isArray(items) ||
                !items.length
            ) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            'Не выбраны товары'

                    });
            }

            const products =
                await getAll(
                    'product'
                );

            const productById =
                new Map(
                    products.map(
                        p => [
                            p.id,
                            p
                        ]
                    )
                );

            const productByCode =
                new Map();

            products.forEach(
                p => {

                    if (p.code) {

                        productByCode.set(
                            normalize(
                                p.code
                            ),
                            p
                        );

                    }

                }
            );

            const extraMaterials =
                [];

            for (
                const id
                of extraMaterialIds || []
            ) {

                const material =
                    productById.get(
                        id
                    );

                if (!material) {

                    return res.status(400)
                        .json({

                            success: false,

                            error:
                                `Материал ${id} не найден`

                        });
                }

                extraMaterials.push(
                    material
                );
            }

            const prepared = [];

            // ------------------------------------------------
            // Сначала определяем карты ТОЛЬКО выбранных товаров
            // ------------------------------------------------

            for (
                const item
                of items
            ) {

                const source =
                    productById.get(
                        item.productId
                    );

                if (!source) {

                    return res.status(400)
                        .json({

                            success: false,

                            error:
                                'Исходный товар не найден'

                        });
                }

                const sourceCode =
                    String(
                        source.code ||
                        ''
                    ).trim();

                const targetCode =
                    /-z$/i.test(
                        sourceCode
                    )
                        ? sourceCode.slice(
                            0,
                            -2
                        )
                        : sourceCode;

                let target =
                    productByCode.get(
                        normalize(
                            targetCode
                        )
                    );

                if (!target) {

                    return res.status(400)
                        .json({

                            success: false,

                            needCreateProducts:
                                true,

                            missing: [

                                {

                                    sourceId:
                                        source.id,

                                    sourceCode,

                                    targetCode

                                }

                            ]

                        });
                }

                // ------------------------------------------------
                // Ищем ТОЛЬКО карту этого targetCode
                // ------------------------------------------------

                let plan =
                    await findPlanByName(
                        targetCode
                    );

                if (!plan) {

                    console.log(
                        `Техкарта ${targetCode} отсутствует — создаём`
                    );

                    plan =
                        await createPlan({

                            product:
                                target,

                            sourceMaterial:
                                source,

                            planFolderId,

                            extraMaterials

                        });

                } else {

                    plan =
                        await updateSelectedPlan({

                            plan,

                            sourceMaterial:
                                source,

                            extraMaterials

                        });

                }

                if (!plan?.id) {

                    throw new Error(
                        `Техкарта ${targetCode} не имеет ID`
                    );

                }

                prepared.push({

                    sourceId:
                        source.id,

                    sourceCode,

                    targetId:
                        target.id,

                    targetCode,

                    quantity:
                        Number(
                            item.quantity ||
                            0
                        ),

                    planId:
                        plan.id

                });
            }

            res.json({

                success: true,

                prepared

            });

        } catch (error) {

            console.error(
                'PROCESSING PREPARE ERROR:',
                errorData(error)
            );

            res.status(
                error.response?.status ||
                500
            ).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// СОЗДАНИЕ ПРОИЗВОДСТВЕННОГО ЗАДАНИЯ
// ============================================================
//
// ВАЖНО:
// МойСклад использует:
//
// productiontask
//
// Обязательные поля:
// organization
// materialsStore
// productsStore
//
// Позиции:
// productionRows
//
// productionRows:
// processingPlan
// productionVolume
//
// ============================================================

app.post(
    '/api/create-processing-order',
    async (req, res) => {

        try {

            const {
                date,
                organizationId,
                materialsStoreId,
                productsStoreId,
                items
            } = req.body;

            if (!organizationId) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            'Не выбрана организация'

                    });
            }

            if (!materialsStoreId) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            'Не выбран склад материалов'

                    });
            }

            if (!productsStoreId) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            'Не выбран склад продукции'

                    });
            }

            if (
                !Array.isArray(items) ||
                !items.length
            ) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            'Нет техкарт для задания'

                    });
            }

            // ------------------------------------------------
            // Проверяем существование карт ТОЛЬКО выбранных
            // ------------------------------------------------

            const productionRows =
                [];

            for (
                const item
                of items
            ) {

                if (!item.planId) {

                    return res.status(400)
                        .json({

                            success: false,

                            error:
                                'У позиции отсутствует planId'

                        });
                }

                const plan =
                    await getPlan(
                        item.planId
                    );

                if (!plan?.id) {

                    return res.status(400)
                        .json({

                            success: false,

                            error:
                                `Техкарта ${item.planId} не найдена`

                        });
                }

                console.log(
                    `Добавляем в производственное задание: ${
                        plan.name ||
                        plan.id
                    } × ${item.quantity}`
                );

                productionRows.push({

                    processingPlan:
                        ref(
                            'processingplan',
                            plan.id
                        ),

                    productionVolume:
                        Number(
                            item.quantity
                        )

                });
            }

            const payload = {

                moment:
                    dateTime(date),

                organization:
                    ref(
                        'organization',
                        organizationId
                    ),

                materialsStore:
                    ref(
                        'store',
                        materialsStoreId
                    ),

                productsStore:
                    ref(
                        'store',
                        productsStoreId
                    ),

                productionRows

            };

            console.log(
                'Создаём производственное задание:',
                JSON.stringify(
                    payload,
                    null,
                    2
                )
            );

            const response =
                await requestApi(
                    'POST',
                    '/entity/productiontask',
                    payload
                );

            res.json({

                success: true,

                document:
                    response.data

            });

        } catch (error) {

            console.error(
                'PRODUCTION TASK ERROR:',
                errorData(error)
            );

            res.status(
                error.response?.status ||
                500
            ).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// ПОИСК КОНТРАГЕНТА
// ============================================================

app.get(
    '/api/counterparties/search',
    async (req, res) => {

        try {

            const q =
                normalize(
                    req.query.q
                );

            const counterparties =
                await getAll(
                    'counterparty'
                );

            const result =
                counterparties
                    .filter(
                        x => {

                            if (!q)
                                return true;

                            return (
                                normalize(
                                    x.name
                                ).includes(q) ||
                                normalize(
                                    x.code
                                ).includes(q)
                            );

                        }
                    )
                    .slice(
                        0,
                        50
                    )
                    .map(
                        x => ({

                            id:
                                x.id,

                            name:
                                x.name ||
                                '',

                            code:
                                x.code ||
                                ''

                        })
                    );

            res.json({

                success: true,

                counterparties:
                    result

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// ОТГРУЗКА
// ============================================================

app.post(
    '/api/create-demand',
    async (req, res) => {

        try {

            const {
                date,
                organizationId,
                counterpartyId,
                storeId,
                items
            } = req.body;

            if (!organizationId)
                throw new Error(
                    'Не выбрана организация'
                );

            if (!counterpartyId)
                throw new Error(
                    'Не выбран контрагент'
                );

            if (!storeId)
                throw new Error(
                    'Не выбран склад'
                );

            const payload = {

                moment:
                    dateTime(date),

                applicable:
                    false,

                organization:
                    ref(
                        'organization',
                        organizationId
                    ),

                agent:
                    ref(
                        'counterparty',
                        counterpartyId
                    ),

                store:
                    ref(
                        'store',
                        storeId
                    ),

                positions:
                    (
                        items || []
                    ).map(
                        item => ({

                            assortment:
                                ref(
                                    'product',
                                    item.productId
                                ),

                            quantity:
                                Number(
                                    item.quantity
                                )

                        })
                    )

            };

            const response =
                await requestApi(
                    'POST',
                    '/entity/demand',
                    payload
                );

            res.json({

                success: true,

                document:
                    response.data

            });

        } catch (error) {

            console.error(
                'DEMAND ERROR:',
                errorData(error)
            );

            res.status(
                error.response?.status ||
                500
            ).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// ЗАКАЗ ПОСТАВЩИКУ
// ============================================================

app.post(
    '/api/create-purchase-order',
    async (req, res) => {

        try {

            const {
                date,
                organizationId,
                counterpartyId,
                storeId,
                items
            } = req.body;

            if (!organizationId)
                throw new Error(
                    'Не выбрана организация'
                );

            if (!counterpartyId)
                throw new Error(
                    'Не выбран контрагент'
                );

            if (!storeId)
                throw new Error(
                    'Не выбран склад'
                );

            const payload = {

                moment:
                    dateTime(date),

                applicable:
                    false,

                organization:
                    ref(
                        'organization',
                        organizationId
                    ),

                agent:
                    ref(
                        'counterparty',
                        counterpartyId
                    ),

                store:
                    ref(
                        'store',
                        storeId
                    ),

                positions:
                    (
                        items || []
                    ).map(
                        item => ({

                            assortment:
                                ref(
                                    'product',
                                    item.productId
                                ),

                            quantity:
                                Number(
                                    item.quantity
                                )

                        })
                    )

            };

            const response =
                await requestApi(
                    'POST',
                    '/entity/purchaseorder',
                    payload
                );

            res.json({

                success: true,

                document:
                    response.data

            });

        } catch (error) {

            console.error(
                'PURCHASE ORDER ERROR:',
                errorData(error)
            );

            res.status(
                error.response?.status ||
                500
            ).json({

                success: false,

                error:
                    errorData(error)

            });
        }
    }
);


// ============================================================
// ПРОВЕРКА СЕРВЕРА
// ============================================================

app.get(
    '/api/test',
    (req, res) => {

        res.json({

            success: true,

            message:
                'Server работает',

            techProcess:
                TECH_PROCESS_ID,

            techStore:
                TECH_STORE_NAME,

            rateLimit:
                `${MIN_REQUEST_INTERVAL} мс`

        });

    }
);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
    (err, req, res, next) => {

        console.error(
            'SERVER ERROR:',
            err
        );

        res.status(500).json({

            success: false,

            error:
                err.message ||
                'Внутренняя ошибка сервера'

        });

    }
);


// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 Сервер запущен: http://localhost:${PORT}`
        );

        console.log(
            `⏱️ Rate-limit защита: ${MIN_REQUEST_INTERVAL} мс + retry`
        );

        console.log(
            '📦 Техкарты проверяются только для выбранных товаров'
        );

        console.log(
            `🏭 Склад по умолчанию: ${TECH_STORE_NAME}`
        );

        console.log(
            `⚙️ Техпроцесс: ${TECH_PROCESS_ID}`
        );

    }
);
