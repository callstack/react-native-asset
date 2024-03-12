const path = require('path');
const slugify = require('slugify');
const { sync: globSync } = require('glob');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const log = require('npmlog');

const REACT_FONT_MANAGER_IMPORT = 'com.facebook.react.views.text.ReactFontManager';

function isProjectUsingKotlin(rootPath) {
  return globSync(path.join(rootPath, 'app/src/main/java/**/MainApplication.kt')).length > 0;
}

function toArrayBuffer(buffer) {
  const arrayBuffer = new ArrayBuffer(buffer.length);
  const view = new Uint8Array(arrayBuffer);

  for (let i = 0; i < buffer.length; i += 1) {
    view[i] = buffer[i];
  }

  return arrayBuffer;
}

function normalizeString(str) {
  return slugify(str, { lower: true }).replaceAll('-', '_');
}

function getProjectFilePath(rootPath, name) {
  const isUsingKotlin = isProjectUsingKotlin(rootPath);
  const ext = isUsingKotlin ? 'kt' : 'java';
  const filePath = globSync(path.join(rootPath, `app/src/main/java/**/${name}.${ext}`))[0];
  return filePath;
}

function getFontFamily(fontFamily, preferredFontFamily) {
  const availableFontFamily = preferredFontFamily || fontFamily;
  return availableFontFamily.en || Object.values(availableFontFamily)[0];
}

/**
 * Calculate a fallback weight to ensure it is multiple of 100 and between 100 and 900.
 *
 * Reference: https://developer.mozilla.org/en-US/docs/Web/CSS/font-weight#fallback_weights
 *
 * @param weight the font's weight.
 * @returns a fallback weight multiple of 100, between 100 and 900, inclusive.
 */
// eslint-disable-next-line consistent-return
function getFontFallbackWeight(weight) {
  if (weight <= 500) {
    return Math.max(Math.floor(weight / 100) * 100, 100);
  } else if (weight > 500) {
    return Math.min(Math.ceil(weight / 100) * 100, 900);
  }
}

function getFontResFolderPath(rootPath) {
  return path.join(rootPath, 'app/src/main/res/font');
}

function getXMLFontId(fontFileName) {
  return `@font/${path.basename(fontFileName, path.extname(fontFileName))}`;
}

function buildXMLFontObjectEntry(fontFile) {
  return {
    '@_app:fontStyle': fontFile.isItalic ? 'italic' : 'normal',
    '@_app:fontWeight': fontFile.weight,
    '@_app:font': getXMLFontId(fontFile.name),
  };
}

function buildXMLFontObject(fontFiles) {
  const fonts = [];
  fontFiles.forEach((fontFile) => {
    const xmlEntry = buildXMLFontObjectEntry(fontFile);

    // We can't have style / weight duplicates.
    const foundEntryIndex = fonts.findIndex(font =>
      font['@_app:fontStyle'] === xmlEntry['@_app:fontStyle'] &&
      font['@_app:fontWeight'] === xmlEntry['@_app:fontWeight']);

    if (foundEntryIndex === -1) {
      fonts.push(xmlEntry);
    } else {
      fonts[foundEntryIndex] = xmlEntry;
    }
  });

  return {
    '?xml': {
      '@_version': '1.0',
      '@_encoding': 'utf-8',
    },
    'font-family': {
      '@_xmlns:app': 'http://schemas.android.com/apk/res-auto',
      font: fonts,
    },
  };
}

function getAddCustomFontMethodCall(fontName, fontId, isKotlin) {
  return `ReactFontManager.getInstance().addCustomFont(this, "${fontName}", R.font.${fontId})${
    isKotlin ? '' : ';'
  }`;
}

function addImportToFile(fileData, importToAdd, isKotlin) {
  const importRegex = new RegExp(
    `import\\s+${importToAdd}${isKotlin ? '' : ';'}`,
    'gm',
  );
  const existingImport = importRegex.exec(fileData);

  if (existingImport) {
    return fileData;
  }

  const packageRegex = isKotlin ? /package\s+[\w.]+/ : /package\s+[\w.]+;/;
  const packageMatch = packageRegex.exec(fileData);

  if (packageMatch) {
    return fileData.replace(
      packageMatch[0],
      `${packageMatch[0]}\n\nimport ${importToAdd}${isKotlin ? '' : ';'}`,
    );
  }

  return fileData;
}

function insertLineInClassMethod(
  fileData,
  targetClass,
  targetMethod,
  codeToInsert,
  lineToInsertAfter,
  isKotlin,
) {
  const classRegex = new RegExp(
    isKotlin
      ? `class\\s+${targetClass}\\s*:\\s*\\S+\\(\\)\\s*,?\\s*(\\S+\\s*)?\\{`
      : `class\\s+${targetClass}(\\s+extends\\s+\\S+)?(\\s+implements\\s+\\S+)?\\s*\\{`,
    'gm',
  );
  const classMatch = classRegex.exec(fileData);

  if (!classMatch) {
    log.error(null, `Class ${targetClass} not found.`);
    return fileData;
  }

  const methodRegex = new RegExp(
    isKotlin
      ? `override\\s+fun\\s+${targetMethod}\\s*\\(\\)`
      : `(public|protected|private)\\s+(static\\s+)?\\S+\\s+${targetMethod}\\s*\\(`,
    'gm',
  );
  let methodMatch = methodRegex.exec(fileData);

  while (methodMatch) {
    if (methodMatch.index > classMatch.index) {
      break;
    }
    methodMatch = methodRegex.exec(fileData);
  }

  if (!methodMatch) {
    log.error(null, `Method ${targetMethod} not found in class ${targetClass}.`);
    return fileData;
  }

  const openingBraceIndex = fileData.indexOf('{', methodMatch.index);
  let closingBraceIndex = -1;
  let braceCount = 1;

  for (let i = openingBraceIndex + 1; i < fileData.length; i += 1) {
    if (fileData[i] === '{') {
      braceCount += 1;
    } else if (fileData[i] === '}') {
      braceCount -= 1;
    }

    if (braceCount === 0) {
      closingBraceIndex = i;
      break;
    }
  }

  if (closingBraceIndex === -1) {
    log.error(null, `Could not find closing brace for method ${targetMethod} in class ${targetClass}.`);
    return fileData;
  }

  const methodBody = fileData.slice(openingBraceIndex + 1, closingBraceIndex);

  if (methodBody.includes(codeToInsert.trim())) {
    return fileData;
  }

  let insertPosition = closingBraceIndex;

  if (lineToInsertAfter) {
    const lineIndex = methodBody.indexOf(lineToInsertAfter.trim());
    if (lineIndex !== -1) {
      insertPosition =
        openingBraceIndex + 1 + lineIndex + lineToInsertAfter.trim().length;
    } else {
      log.error(null, `Line "${lineToInsertAfter}" not found in method ${targetMethod} of class ${targetClass}.`);
      return fileData;
    }
  }

  return `${fileData.slice(
    0,
    insertPosition,
  )}\n    ${codeToInsert}${fileData.slice(insertPosition)}`;
}

function removeLineFromFile(fileData, stringToRemove) {
  const lines = fileData.split('\n');
  const updatedLines = lines.filter(line => !line.includes(stringToRemove));
  return updatedLines.join('\n');
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: tagName => tagName === 'font',
});

const xmlBuilder = new XMLBuilder({
  format: true,
  ignoreAttributes: false,
  suppressEmptyNode: true,
});

module.exports = {
  REACT_FONT_MANAGER_IMPORT,
  isProjectUsingKotlin,
  toArrayBuffer,
  normalizeString,
  getProjectFilePath,
  getFontFamily,
  getFontFallbackWeight,
  getFontResFolderPath,
  getXMLFontId,
  buildXMLFontObjectEntry,
  buildXMLFontObject,
  getAddCustomFontMethodCall,
  addImportToFile,
  insertLineInClassMethod,
  removeLineFromFile,
  xmlParser,
  xmlBuilder,
};
