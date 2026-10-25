import { createRoot } from 'react-dom/client';
import { LocalToolClient } from './api.js';
import { DesktopHostAdapter } from './host-adapter.js';
import { Workbench } from './Workbench.js';
import './styles.css';
const desktop = window.parent !== window;
const client = desktop ? new DesktopHostAdapter() : new LocalToolClient();
createRoot(document.getElementById('root')!).render(<Workbench client={client} mode={desktop ? 'desktop' : 'local'}/>);
