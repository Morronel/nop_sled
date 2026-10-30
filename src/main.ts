import './styles.css';
import { loadSave } from './game/save';
import { detectLang, setLang } from './i18n';
import { App } from './ui/app';

const data = loadSave();
setLang(data.lang ?? detectLang());
new App(document.getElementById('app')!);
