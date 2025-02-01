import fs from 'fs';
import mathjax from 'mathjax';
import reader from './reader.js';
import { pngDimensions, pngFitTo, rsvgConvert } from './magick.js';
import { sendNotification, saveFile } from './debug.js';
import { sha256Hash } from './util.js';
import { randomBytes } from 'node:crypto';
import { onExit } from './onexit.js';

// To prevent conflicts with other instances
const DIRECTORY_SUFFIX = randomBytes(3).toString('hex');

const PREAMBLE_PATH = '/home/fireond/Documents/Obsidian-Vault/preamble.tex'; // 修改为实际路径

// TODO: Portable directory instead of Unix-specific
const IMG_DIR = `/tmp/nvim-mdmath-${DIRECTORY_SUFFIX}`;

/** @typedef {{equation: string, filename: string}} Equation */

/** @type {Equation[]} */
const equations = [];

/** @type {Object.<string, Equation>} */
const equationMap = {};

const svgCache = {};

let internalScale = 1;
let dynamicScale = 1;

let MathJax = undefined;

class MathError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MathError';
    }
}

function mkdirSync(path) {
    try {
        fs.mkdirSync(path, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST')
            throw err;
    }
}


/**
 * 从 LaTeX 文件中解析 \newcommand, \DeclareMathOperator 等命令
 * @param {string} content
 * @returns {Record<string, string|string[]>}
 */
function parseLatexCommands(content) {
    const macros = {};

    // 解析 \newcommand 和 \renewcommand
    const newCommandRegex = /\\(?:re)?newcommand{\\([^}]+)}(?:\[(\d+)])?{([^}]+)}/g;
    let match;
    while ((match = newCommandRegex.exec(content)) !== null) {
        const name = match[1];
        const numArgs = match[2] ? parseInt(match[2]) : 0;
        const replacement = match[3].trim();
        macros[name] = numArgs > 0 ? [replacement, numArgs] : replacement;
    }

    // 解析 \DeclareMathOperator 和 \DeclareMathOperator*
    const declareMathOpRegex = /\\DeclareMathOperator(\*?){\\([^}]+)}{([^}]+)}/g;
    while ((match = declareMathOpRegex.exec(content)) !== null) {
        const star = match[1]; // 捕获是否有星号（*）
        const name = match[2];
        const operator = match[3];
        // 生成 MathJax 兼容的运算符定义
        macros[name] = star
            ? `\\mathop{\\operatorname*{${operator}}}`  // 带星号版本（上下标在顶部）
            : `\\mathop{\\mathrm{${operator}}}`;        // 无星号版本（默认样式）
    }

    return macros;
}

/**
 * @param {string} equation
 * @returns {Promise<{svg: string} | {error: string}>}
 */
async function equationToSVG(equation) {
    if (equation in svgCache)
        return svgCache[equation];

    try {
        const svg = await MathJax.tex2svgPromise(equation);
        return svgCache[equation] = {
            svg: MathJax.startup.adaptor.innerHTML(svg)
        }
    } catch (err) {
        if (err instanceof MathError) {
            return svgCache[equation] = {
                error: err.message
            }
        } else {

        }

        throw err;
    }
}

function write(identifier, width, height, data) {
    process.stdout.write(`${identifier}:image:${width}:${height}:${data.length}:${data}`);
}

function writeError(identifier, error) {
    process.stdout.write(`${identifier}:error:0:0:${error.length}:${error}`);
}

function parseViewbox(svgString) {
    const viewboxMatch = svgString.match(/viewBox="([^"]+)"/);
    if (!viewboxMatch) return null;

    const [minX, minY, width, height] = viewboxMatch[1].split(' ').map(parseFloat);
    return { minX, minY, width, height };
}

/**
  * @param {string} identifier
  * @param {string} equation
*/
async function processEquation(identifier, equation, cWidth, cHeight, width, height, flags, color) {
    if (!equation || equation.trim().length === 0)
        return writeError(identifier, 'Empty equation')

    const equation_key = `${equation}_${cWidth}*${width}x${cHeight}*${height}_${flags}_${color}`;
    if (equation_key in equationMap) {
        const equationObj = equationMap[equation_key];
        return write(identifier, equationObj.width, equationObj.height, equationObj.filename);
    }

    let {svg, error} = await equationToSVG(equation);
    if (!svg)
        return writeError(identifier, error)

    svg = svg
        .replace(/currentColor/g, color)
        .replace(/style="[^"]+"/, '')

    const isDynamic = !!(flags & 1);

    let basePNG;
    let iWidth, iHeight;
    if (isDynamic) {
        const zoom = 10 * dynamicScale * cHeight * internalScale / 96;
        basePNG = await rsvgConvert(svg, {zoom});

        const {width: pngWidth, height: pngHeight} = await pngDimensions(basePNG);

        const newWidth = (pngWidth / internalScale) / cWidth;
        const newHeight = (pngHeight / internalScale) / cHeight;

        // If the image is smaller than the cell, it's better to keep the original size, so
        width = Math.max(width, Math.ceil(newWidth));
        height = Math.max(height, Math.ceil(newHeight));

        iWidth = width * cWidth * internalScale;
        iHeight = height * cHeight * internalScale;
    } else {
        iWidth = width * cWidth * internalScale;
        iHeight = height * cHeight * internalScale;

        basePNG = await rsvgConvert(svg, {width: iWidth, height: iHeight});
    }

    const hash = sha256Hash(equation).slice(0, 7);
    const isCenter = !!(flags & 2);
    const filename = `${IMG_DIR}/${hash}_${iWidth}x${iHeight}.png`;

    await pngFitTo(basePNG, filename, iWidth, iHeight, {center: isCenter});

    const equationObj = {equation, filename, width, height};
    equations.push(equationObj);
    equationMap[equation_key] = equationObj;

    write(identifier, width, height, filename);
}

function processAll(request) {
    if (request.type === 'request') {
        return processEquation(
            request.identifier,
            request.data,
            request.cellWidth,
            request.cellHeight,
            request.width,
            request.height,
            request.flags,
            request.color
        ).catch((err) => {
            writeError(request.identifier, err.message);
        });
    } else if (request.type === 'dscale') {
        // FIXME: Invalidate cache when scale changes
        dynamicScale = request.scale;
    } else if (request.type === 'iscale') {
        // FIXME: Invalidate cache when scale changes
        internalScale = request.scale;
    }
}

function main() {
    mkdirSync(IMG_DIR);

     // 读取并解析 preamble.tex
    let preambleContent;
    try {
        preambleContent = fs.readFileSync(PREAMBLE_PATH, 'utf-8');
    } catch (err) {
        console.error(`无法加载 preamble.tex: ${err.message}`);
        process.exit(1);
    }

    const customMacros = parseLatexCommands(preambleContent);

    onExit(() => {
        equations.forEach(({filename}) => {
            try {
                fs.unlinkSync(filename);
            } catch (err) {}
        });

        try {
            fs.rmdirSync(IMG_DIR);
        } catch (err) {}
    });

    mathjax.init({
        loader: { load: ['input/tex', 'output/svg'] },
        tex: {
            formatError: (_, err) => {
                throw new MathError(err.message);
            },
            macros: customMacros // 注入解析后的宏
        }
    }).then((MathJax_) => {
        MathJax = MathJax_;
        reader.listen(processAll);
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

main();
