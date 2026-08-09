export function createDialogs(root) {
    const dialog = root.querySelector('#chat_sentinel_dialog');
    const title = dialog.querySelector('[data-dialog-title]');
    const body = dialog.querySelector('[data-dialog-body]');
    const confirm = dialog.querySelector('[data-dialog-confirm]');
    const cancel = dialog.querySelector('[data-dialog-cancel]');

    function ask({ heading, message, confirmText = '确认', danger = false }) {
        const returnFocus = document.activeElement;
        title.textContent = heading;
        body.textContent = message;
        confirm.textContent = confirmText;
        confirm.classList.toggle('chat_sentinel_danger', danger);
        return new Promise((resolve) => {
            const finish = (value) => {
                confirm.removeEventListener('click', onConfirm);
                cancel.removeEventListener('click', onCancel);
                dialog.removeEventListener('cancel', onCancel);
                dialog.removeEventListener('keydown', onKeydown);
                dialog.close();
                returnFocus?.focus?.();
                resolve(value);
            };
            const onConfirm = () => finish(true);
            const onCancel = (event) => {
                event?.preventDefault();
                finish(false);
            };
            const onKeydown = (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(false);
                    return;
                }
                if (event.key !== 'Tab') return;
                const focusables = [cancel, confirm].filter((item) => !item.disabled);
                const first = focusables[0];
                const last = focusables.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            };
            confirm.addEventListener('click', onConfirm);
            cancel.addEventListener('click', onCancel);
            dialog.addEventListener('cancel', onCancel);
            dialog.addEventListener('keydown', onKeydown);
            dialog.showModal();
            cancel.focus();
        });
    }

    return { ask };
}
