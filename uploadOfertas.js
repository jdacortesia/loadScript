const puppeteer = require('puppeteer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
function getChromiumPath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    try { return execSync('which chromium').toString().trim(); } catch (_) {}
    try { return execSync('which chromium-browser').toString().trim(); } catch (_) {}
    return null;
}

/**
 * Reads data from Excel/CSV.
 * raw: false keeps date formatting intact from Excel cells.
 * Code columns (origen, destino) are sanitized separately by sanitizeCode().
 */
async function readData(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    // Read as UTF-8 string first to avoid latin-1 misinterpretation of Spanish characters
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const workbook = XLSX.read(fileContent, { type: 'string' });
    const sheetName = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        defval: "",
        raw: false
    });
}

/**
 * Scans every frame (including main) for the given selector.
 */
async function findFrameWithSelector(page, selector) {
    for (const frame of page.frames()) {
        try {
            const element = await frame.$(selector);
            if (element) return frame;
        } catch (e) {
            continue;
        }
    }
    return null;
}

/**
 * Sets a value on any input field using the native HTMLInputElement value setter.
 * This completely bypasses Puppeteer keyboard simulation (which causes "not iterable"
 * errors when the target element is inside an iframe or is type="number"), and works
 * regardless of the input type or the JS framework on the page.
 */
async function customType(_page, ctx, selector, value) {
    const textToType = (value !== undefined && value !== null) ? `${value}` : "";

    try {
        await ctx.waitForSelector(selector, { timeout: 8000 });

        const result = await ctx.evaluate((sel, val) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: 'Element not found in DOM' };

            try { el.focus(); } catch (e) {
                return { ok: false, error: `focus() threw: ${e.message}` };
            }

            try {
                const proto = el.tagName === 'TEXTAREA'
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                nativeSetter.call(el, val);
            } catch (e) {
                return { ok: false, error: `nativeSetter threw: ${e.message}` };
            }

            try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { }
            try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) { }

            return { ok: true };
        }, selector, textToType);

        if (!result.ok) throw new Error(result.error);

    } catch (e) {
        throw new Error(`Field Error [${selector}]: ${e.message}`);
    }
}

/**
 * Reads the current value of a field. Used for pre-submit verification.
 */
async function getFieldValue(ctx, selector) {
    try {
        return await ctx.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? el.value : null;
        }, selector);
    } catch (_) {
        return null;
    }
}

/**
 * Selects an option in a <select> dropdown.
 * Matches by visible text or value, case-insensitive.
 * Skips silently if value is empty.
 */
async function customSelect(ctx, selector, value) {
    const textToMatch = (value !== undefined && value !== null) ? `${value}`.trim() : "";
    if (!textToMatch) return;

    try {
        await ctx.waitForSelector(selector, { timeout: 8000 });

        const result = await ctx.evaluate((sel, val) => {
            const select = document.querySelector(sel);
            if (!select) return { matched: false, debug: 'select element not found' };
            const normalized = val.toLowerCase();

            const debug = {
                jQueryAvailable: typeof window.$ !== 'undefined',
                selectId: select.id,
                selectName: select.name,
                optionCount: select.options.length,
                valueBeforeSet: select.value,
                optionValues: [...select.options].map(o => ({ text: o.text.trim(), value: o.value })),
            };

            for (const opt of select.options) {
                if (
                    opt.text.trim().toLowerCase() === normalized ||
                    opt.value.trim().toLowerCase() === normalized
                ) {
                    debug.matchedText = opt.text.trim();
                    debug.matchedValue = opt.value;

                    opt.selected = true;
                    select.value = opt.value;

                    try {
                        const nativeSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLSelectElement.prototype, 'value'
                        ).set;
                        nativeSetter.call(select, opt.value);
                    } catch (e) { debug.nativeSetterError = e.message; }

                    try {
                        if (window.$) window.$(select).val(opt.value).trigger('change');
                    } catch (e) { debug.jqueryError = e.message; }

                    select.dispatchEvent(new Event('change', { bubbles: true }));

                    debug.valueAfterSet = select.value;
                    debug.selectedIndex = select.selectedIndex;
                    debug.selectedOptionText = select.options[select.selectedIndex]?.text;

                    return { matched: true, debug };
                }
            }

            return { matched: false, debug };
        }, selector, textToMatch);

        const matched = result.matched;
        console.log(`    [customSelect] ${selector} → ${JSON.stringify(result.debug)}`);

        if (!matched) {
            const available = await ctx.evaluate((sel) => {
                const select = document.querySelector(sel);
                return select ? [...select.options].map(o => o.text.trim()).join(' | ') : '(select not found)';
            }, selector);
            throw new Error(`No option matched "${textToMatch}". Available: ${available}`);
        }
    } catch (e) {
        throw new Error(`Dropdown Error [${selector}]: ${e.message}`);
    }
}

/**
 * Selects a predefined option in a Select2 dropdown (tipo_unidad, tipo_remolque).
 * Finds the matching <option> by text in the underlying <select>, then uses the
 * jQuery Select2 API (.val().trigger('change')) to set it — no visual interaction needed.
 */
async function customSelect2Option(ctx, selectId, value) {
    const text = (value !== undefined && value !== null) ? `${value}`.trim() : '';
    if (!text) return;

    try {
        await ctx.waitForSelector(selectId, { timeout: 8000 });

        // Step 1: check if the underlying <select> already has options loaded
        const hasOptions = await ctx.evaluate((id) => {
            const select = document.querySelector(id);
            // Ignore the blank placeholder option (value="")
            return select ? [...select.options].filter(o => o.value !== '').length > 0 : false;
        }, selectId);

        // Step 2: if no options yet (dependent dropdown waiting on AJAX), open the dropdown
        //         so Select2 triggers its data source / AJAX call
        if (!hasOptions) {
            await ctx.evaluate((id) => {
                if (window.$ && window.$.fn.select2) window.$(id).select2('open');
            }, selectId);
            // Wait for results to appear in the DOM
            await ctx.waitForSelector('.select2-results__option:not(.loading-results)', { timeout: 8000 });
            await new Promise(r => setTimeout(r, 300));
            // Close dropdown — we'll set via API below
            await ctx.evaluate((id) => {
                if (window.$ && window.$.fn.select2) window.$(id).select2('close');
            }, selectId);
            await new Promise(r => setTimeout(r, 200));
        }

        const result = await ctx.evaluate((id, val) => {
            const normalized = val.toLowerCase().trim();
            const select = document.querySelector(id);
            if (!select) return { ok: false, error: 'select element not found' };

            const available = [...select.options].map(o => o.text.trim());

            // Exact match first, then partial
            let matchedValue = null;
            let matchedText = null;
            for (const opt of select.options) {
                if (opt.text.trim().toLowerCase() === normalized) {
                    matchedValue = opt.value;
                    matchedText = opt.text.trim();
                    break;
                }
            }
            if (matchedValue === null) {
                for (const opt of select.options) {
                    if (opt.text.trim().toLowerCase().includes(normalized)) {
                        matchedValue = opt.value;
                        matchedText = opt.text.trim();
                        break;
                    }
                }
            }

            if (matchedValue === null) return { ok: false, available };

            // Use Select2 jQuery API — the authoritative way to set a value programmatically
            if (window.$ && window.$.fn.select2) {
                window.$(id).val(matchedValue).trigger('change');
                return { ok: true, matched: matchedText };
            }

            // Fallback: set via native setter + dispatch change
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLSelectElement.prototype, 'value'
            ).set;
            nativeSetter.call(select, matchedValue);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, matched: matchedText, usedFallback: true };

        }, selectId, text);

        if (!result.ok) {
            throw new Error(`No option matched "${text}". Available: ${result.available?.join(' | ')}`);
        }

    } catch (e) {
        throw new Error(`Select2 Option Error [${selectId}]: ${e.message}`);
    }
}

/**
 * Handles a Select2 tag input (contacto field):
 *  1. Removes all existing tags by clicking their × buttons
 *  2. Clicks the Select2 container to open the search input
 *  3. Sets the value on the search input via native setter
 *  4. Fires keydown Enter so Select2 confirms the tag
 * Skips silently if value is empty.
 */
async function customSelect2Tag(ctx, value) {
    const text = (value !== undefined && value !== null) ? `${value}`.trim() : '';
    if (!text) return;

    try {
        await ctx.waitForSelector('.select2-selection__rendered', { timeout: 8000 });

        // Step 1: Remove every existing tag
        await ctx.evaluate(() => {
            document.querySelectorAll('.select2-selection__choice__remove')
                .forEach(btn => btn.click());
        });
        await new Promise(r => setTimeout(r, 200));

        // Step 2: Click the Select2 selection area to open the search input
        await ctx.evaluate(() => {
            const el = document.querySelector('.select2-selection__rendered');
            if (el) el.click();
        });
        await new Promise(r => setTimeout(r, 400));

        // Step 3: Set value on the search input Select2 injects after click
        const inputFound = await ctx.evaluate((val) => {
            const input = document.querySelector('.select2-search__field');
            if (!input) return false;
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeSetter.call(input, val);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }, text);

        if (!inputFound) throw new Error('Select2 search input not visible after click');
        await new Promise(r => setTimeout(r, 300));

        // Step 4: Fire Enter keydown so Select2 adds the tag
        await ctx.evaluate(() => {
            const input = document.querySelector('.select2-search__field');
            if (input) {
                input.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter', keyCode: 13, which: 13, bubbles: true
                }));
            }
        });
        await new Promise(r => setTimeout(r, 200));

    } catch (e) {
        throw new Error(`Select2 Tag Error [contacto]: ${e.message}`);
    }
}

/**
 * Selects the Negociar radio button by its fixed IDs:
 *   Sí → #id-opt-negociar-1
 *   No → #id-opt-negociar-2
 * Skips silently if value is empty.
 */
async function customRadioNegociar(ctx, value) {
    const textToMatch = (value !== undefined && value !== null) ? `${value}`.trim().toLowerCase() : "";
    if (!textToMatch) return;

    const siValues = ['sí', 'si', 'yes', '1', 'true'];
    const selector = siValues.includes(textToMatch) ? '#id-opt-negociar-1' : '#id-opt-negociar-2';

    try {
        await ctx.waitForSelector(selector, { timeout: 8000 });
        await ctx.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
                el.click();
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, selector);
    } catch (e) {
        throw new Error(`Radio Error [negociar="${value}"]: ${e.message}`);
    }
}

/**
 * Strips thousands-separator formatting from numeric code strings.
 * Prevents XLSX from turning code 12345 into "12,345".
 */
function sanitizeCode(value) {
    return `${value}`.replace(/[,\s]/g, '');
}



// --- Main Core ---

async function runWithConfig(config, logCallback) {
    const {
        email,
        password,
        contactoOverride,
        dataFilePath,
        dryRun = false,
        headless = false
    } = config;

    // Unified logger: stdout + SSE callback when called from server
    const log = (msg) => {
        console.log(msg);
        if (typeof logCallback === 'function') logCallback(msg);
    };

    log('--- Starting Flete Hub Automation ---');

    let data;
    try {
        data = await readData(dataFilePath);
        log(`| CSV Loaded: ${data.length} rows.`);
    } catch (err) {
        log(`| Fatal: ${err.stack || err.message}`);
        return;
    }

    const browser = await puppeteer.launch({
        headless,
        defaultViewport: null,
        executablePath: getChromiumPath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--start-maximized']
    });

    const [page] = await browser.pages();
    let successCount = 0;
    const failedRows = []; // Tracks row numbers that failed

    try {
        // 1. LOGIN — use evaluate/native setter to avoid page.type() "not iterable" errors
        log('| Logging in...');
        await page.goto('https://hub.flete.com/lite/seg_Login/', { waitUntil: 'networkidle2' });
        await page.evaluate((em, pw) => {
            const setVal = (sel, val) => {
                const el = document.querySelector(sel);
                if (!el) throw new Error(`Login field not found: ${sel}`);
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ).set;
                nativeSetter.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setVal('#id_sc_field_login', em);
            setVal('#id_sc_field_pswd', pw);
        }, `${email}`, `${password}`);
        await Promise.all([
            page.evaluate(() => {
                const btn = document.querySelector('input[value="Iniciar Sesión"]');
                if (btn) btn.click();
            }),
            page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);
        log('| Login successful.');

        // 2. ITERATE ROWS
        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            const rowIdx = i + 1;
            log(`\n[Row ${rowIdx}/${data.length}] Processing: ${row.origen} -> ${row.destino}`);

            try {
                // A. Click "Nueva oferta" — find+click atomically inside evaluate to avoid
                //    stale element errors when the iframe reloads between $ and .click()
                let btnClicked = false;
                for (let attempt = 0; attempt < 10; attempt++) {
                    for (const frame of page.frames()) {
                        try {
                            const clicked = await frame.evaluate(() => {
                                const btn = document.querySelector('button.btn-cta');
                                if (btn) { btn.click(); return true; }
                                return false;
                            });
                            if (clicked) { btnClicked = true; break; }
                        } catch (_) { }
                    }
                    if (btnClicked) break;
                    log(`| [Row ${rowIdx}] "Nueva oferta" not ready, retrying (${attempt + 1}/10)...`);
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!btnClicked) throw new Error('Could not find "Nueva oferta" button after 10s.');

                // B. Find the frame that contains the form (with retries)
                let modalFrame = null;
                const targetSelector = '#id_sc_field_dt_coleta';

                for (let retry = 0; retry < 12; retry++) {
                    modalFrame = await findFrameWithSelector(page, targetSelector);
                    if (modalFrame) break;
                    await new Promise(r => setTimeout(r, 1000));
                }

                if (!modalFrame) throw new Error('Form modal not found in any iframe.');

                // Wait for the form inside the modal to be fully interactive
                await modalFrame.waitForSelector('#id_sc_field_dt_coleta', { visible: true, timeout: 10000 });
                await new Promise(r => setTimeout(r, 500));

                // Log the frame URL so we can confirm we're targeting the right one
                log(`| [Row ${rowIdx}] Modal frame URL: ${modalFrame.url()}`);

                // Dump raw row data so we can see exactly what XLSX returned
                log(`| [Row ${rowIdx}] Raw row data: ${JSON.stringify(row)}`);

                // C. contacto: override wins; CSV row is fallback
                const contactoValue = (contactoOverride && contactoOverride.trim())
                    ? contactoOverride
                    : row.contacto;

                // D. Step-by-step field filling
                // Each entry: [label, type, selector, value]
                // type: 'text' | 'select' | 'radio' | 'optional-text'
                const fields = [
                    ['fecha_recogida', 'text', '#id_sc_field_dt_coleta', row.fecha_recogida],
                    ['fecha_entrega', 'text', '#id_sc_field_dt_entrega', row.fecha_entrega],
                    ['origen', 'text', '#id_sc_field_id_cad_cidade_col', sanitizeCode(row.origen)],
                    ['destino', 'text', '#id_sc_field_id_cad_cidade_ent', sanitizeCode(row.destino)],
                    ['producto', 'text', '#id_sc_field_nm_produto', row.producto],
                    ['valor_flete', 'text', '#id_sc_field_vl_valor_mot', row.valor_flete],
                    ['observaciones', 'text', '#id_sc_field_ds_descricao', row.observaciones],
                    ['tipo_unidad', 'select2-option', '#id_sc_field_id_tp_veiculo', row.tipo_unidad],
                    ['tipo_remolque', 'select2-option', '#id_sc_field_id_tp_carroceria', row.tipo_remolque],
                    ['negociar', 'radio', null, row.negociar],
                    ['contacto', 'select2', null, contactoValue],
                ];

                for (const [label, type, selector, value] of fields) {
                    const display = `${value}`.trim() || '(empty)';
                    log(`  > Filling ${label}: ${display}`);
                    try {
                        if (type === 'text') {
                            await customType(page, modalFrame, selector, value);
                        } else if (type === 'select2-option') {
                            await customSelect2Option(modalFrame, selector, value);
                        } else if (type === 'radio') {
                            await customRadioNegociar(modalFrame, value);
                        } else if (type === 'select2') {
                            await customSelect2Tag(modalFrame, value);
                        }
                        log(`  ✓ ${label} OK`);
                        // tipo_remolque options are loaded dynamically after tipo_unidad is set —
                        // give the page time to fetch and populate them before continuing
                        if (label === 'tipo_unidad') {
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    } catch (fieldErr) {
                        log(`  ✗ ${label} FAILED: ${fieldErr.message}`);
                        throw fieldErr; // Propagate so the row is marked as failed
                    }
                }

                // E. Pre-submit verification — read back values and flag any mismatch
                log(`| [Row ${rowIdx}] Verifying fields before submit...`);
                const verifyMap = [
                    ['fecha_recogida', '#id_sc_field_dt_coleta', row.fecha_recogida],
                    ['fecha_entrega', '#id_sc_field_dt_entrega', row.fecha_entrega],
                    ['origen', '#id_sc_field_id_cad_cidade_col', sanitizeCode(row.origen)],
                    ['destino', '#id_sc_field_id_cad_cidade_ent', sanitizeCode(row.destino)],
                    ['producto', '#id_sc_field_nm_produto', row.producto],
                    // valor_flete excluded: currency mask reformats the raw value after input event,
                    // so the displayed value will never match the CSV string directly.
                ];
                let verifyPassed = true;
                for (const [label, selector, expected] of verifyMap) {
                    if (!expected || `${expected}`.trim() === '') continue; // Skip empty fields
                    const actual = await getFieldValue(modalFrame, selector);
                    if (`${actual}`.trim() !== `${expected}`.trim()) {
                        log(`  ! Mismatch on ${label}: expected "${expected}", got "${actual}"`);
                        verifyPassed = false;
                    }
                }
                if (!verifyPassed) {
                    throw new Error('Pre-submit verification failed — one or more fields did not fill correctly.');
                }
                log(`| [Row ${rowIdx}] Verification passed.`);

                // F. Dry Run: stop after first row — leave modal open for 15s so it can be inspected
                if (dryRun) {
                    log(`| [Row ${rowIdx}] Dry Run complete — modal stays open for 15s, then script exits.`);
                    await new Promise(r => setTimeout(r, 3000000));
                    return; // Stop — do not process further rows
                }

                // G. Submit
                log(`| [Row ${rowIdx}] Clicking Agregar...`);
                await modalFrame.evaluate(() => {
                    const btn = document.querySelector('#sc_b_ins_t');
                    if (btn) btn.click();
                });

                // Wait for modal to close or network to settle instead of a fixed sleep
                await Promise.race([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => { }),
                    new Promise(r => setTimeout(r, 6000))
                ]);

                successCount++;
                log(`| [Row ${rowIdx}] Submitted successfully.`);

            } catch (rowErr) {
                failedRows.push(rowIdx);
                log(`| ERROR Row ${rowIdx}: ${rowErr.stack || rowErr.message}`);
                // Navigate home — this closes the modal naturally without clicking anything
                await page.goto('https://hub.flete.com/lite/inicio/', { waitUntil: 'networkidle2' }).catch(() => { });
            }
        }

        // 3. FINAL SUMMARY
        log('\n--- Process Complete ---');
        log(`Submitted:  ${successCount} / ${data.length}`);
        log(`Failed:     ${failedRows.length}${failedRows.length > 0 ? ` (rows: ${failedRows.join(', ')})` : ''}`);

    } catch (err) {
        log(`| CRITICAL: ${err.stack || err.message}`);
    } finally {
        await browser.close();
    }
}

// Export for server.js
module.exports = { runWithConfig };

// Standalone execution — only runs when invoked directly (node uploadOfertas.js)
if (require.main === module) {
    const config = {
        email: '',
        password: '',
        dataFilePath: path.join(__dirname, 'ofertas_template.csv'),
        dryRun: true,
        headless: false
    };
    runWithConfig(config);
}
