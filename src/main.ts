import './styles/style.css';
import { App } from './app/index.ts';

const mount = document.querySelector<HTMLDivElement>('#app');
if (!mount) throw new Error('#app mount point missing');

new App(mount).start();
