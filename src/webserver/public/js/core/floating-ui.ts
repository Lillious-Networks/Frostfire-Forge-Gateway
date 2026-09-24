import draggableUI from "./draggable.js";

interface PanelConfig {
  id: string;
  title: string;
  closeable: boolean;
}

class FloatingUIManager {
  private panels: PanelConfig[] = [
    { id: 'inventory', title: 'Inventory', closeable: true },
    { id: 'chat-container', title: 'Chat', closeable: false },
    { id: 'stats-container', title: 'Player Stats', closeable: false },
    { id: 'spell-book-container', title: 'Spell Book', closeable: true },
    { id: 'quest-log-container', title: 'Quest Log', closeable: true },
    { id: 'friends-list-container', title: 'Friends', closeable: true },
    { id: 'guild-container', title: 'Guild', closeable: true },
  ];

  public initialize() {
    this.panels.forEach(config => {
      const element = document.getElementById(config.id);
      if (element) {
        this.convertToFloatingPanel(element, config);
      }
    });

    this.addResetButton();
  }

  private convertToFloatingPanel(element: HTMLElement, config: PanelConfig) {

    element.classList.add('floating-panel');

    const header = document.createElement('div');
    header.className = 'floating-panel-header ui';

    const title = document.createElement('div');
    title.className = 'floating-panel-title ui';
    title.textContent = config.title;

    header.appendChild(title);

    if (config.closeable) {
      const closeBtn = document.createElement('div');
      closeBtn.className = 'floating-panel-close ui';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => {
        element.style.display = 'none';
      });
      header.appendChild(closeBtn);
    }

    const content = document.createElement('div');
    content.className = 'floating-panel-content ui';

    while (element.firstChild) {
      content.appendChild(element.firstChild);
    }

    element.appendChild(header);
    element.appendChild(content);

    draggableUI.registerPanel(config.id, element, header);

    element.style.display = 'block';
  }

  private addResetButton() {
    const debugContainer = document.getElementById('debug-container');
    if (debugContainer) {
      const resetBtn = document.createElement('button');
      resetBtn.textContent = 'Reset UI Positions';
      resetBtn.className = 'ui';
      resetBtn.style.cssText = 'padding: 5px 10px; margin-top: 10px; cursor: pointer; background: #029656; border: none; border-radius: 4px; color: white;';
      resetBtn.addEventListener('click', () => {
        if (confirm('Reset all UI panel positions to default?')) {
          draggableUI.resetPositions();
        }
      });
      debugContainer.appendChild(resetBtn);
    }
  }
}

const floatingUIManager = new FloatingUIManager();
export default floatingUIManager;
