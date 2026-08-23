import ReactDOM from 'react-dom/client';
import '../../src/ui/options.css';
import '../../src/ui/popup.css';
import { Options } from '../../src/ui/Options';

ReactDOM.createRoot(document.getElementById('root')!).render(<Options compact />);
