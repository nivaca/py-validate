// Copies ../validate.py and ../LICENSE into the extension folder so the
// packaged .vsix works on its own (schematron.validatorPath can override it).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const ext = path.resolve(__dirname, '..');

fs.mkdirSync(path.join(ext, 'validator'), { recursive: true });
fs.copyFileSync(path.join(root, 'validate.py'), path.join(ext, 'validator', 'validate.py'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(ext, 'LICENSE'));
console.log('bundled validate.py and LICENSE');
