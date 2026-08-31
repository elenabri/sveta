const express = require('express');
const axios = require('axios');
const path = require('path');

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

app.use(express.json({ limit: '10mb' }));

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

            if (!folderId) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            'Не выбрана папка'

                    });
            }

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

            products.forEach(
                p => {

                    if (p.code) {

                        byCode.set(
                            normalize(
                                p.code
                            ),
                            p
                        );

                    }

                }
            );

            const created = [];
            const errors = [];

            for (
                const item
                of items || []
            ) {

                const source =
                    byId.get(
                        item.sourceId
                    );

                if (!source) {

                    errors.push({

                        code:
                            item.targetCode,

                        error:
                            'Исходная карточка не найдена'

                    });

                    continue;
                }

                const exists =
                    byCode.get(
                        normalize(
                            item.targetCode
                        )
                    );

                if (exists) {

                    created.push({

                        id:
                            exists.id,

                        code:
                            exists.code,

                        name:
                            exists.name,

                        alreadyExists:
                            true

                    });

                    continue;
                }

                const payload = {

                    name:
                        source.name ||
                        item.targetCode,

                    code:
                        item.targetCode,

                    article:
                        source.article ||
                        '',

                    description:
                        source.description ||
                        '',

                    productFolder:
                        ref(
                            'productfolder',
                            folderId
                        )

                };

                if (
                    source.uom?.meta
                ) {

                    payload.uom = {

                        meta:
                            source.uom.meta

                    };

                }

                try {

                    const response =
                        await requestApi(
                            'POST',
                            '/entity/product',
                            payload
                        );

                    const product =
                        response.data;

                    byCode.set(
                        normalize(
                            product.code
                        ),
                        product
                    );

                    created.push({

                        id:
                            product.id,

                        code:
                            product.code,

                        name:
                            product.name,

                        alreadyExists:
                            false

                    });

                } catch (error) {

                    errors.push({

                        code:
                            item.targetCode,

                        error:
                            errorData(error)

                    });

                }
            }

            res.json({

                success:
                    errors.length === 0,

                created,

                errors

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
