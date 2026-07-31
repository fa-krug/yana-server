/**
 * Copy button functionality for textarea widgets in Django admin.
 */
(function() {
    'use strict';

    function initCopyButtons() {
        document.querySelectorAll('.copy-button').forEach(function(button) {
            // Skip if already initialized
            if (button.dataset.initialized) return;
            button.dataset.initialized = 'true';

            button.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();

                var targetId = this.dataset.target;
                var textarea = document.getElementById(targetId);

                if (!textarea) {
                    console.error('Target textarea not found:', targetId);
                    return;
                }

                var textToCopy = textarea.value;

                // Use the Clipboard API if available
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(textToCopy).then(function() {
                        showCopiedFeedback(button);
                    }).catch(function(err) {
                        console.error('Failed to copy:', err);
                        fallbackCopy(textarea, button);
                    });
                } else {
                    fallbackCopy(textarea, button);
                }
            });
        });
    }

    function fallbackCopy(textarea, button) {
        // Fallback for older browsers
        textarea.select();
        textarea.setSelectionRange(0, 99999); // For mobile devices

        try {
            document.execCommand('copy');
            showCopiedFeedback(button);
        } catch (err) {
            console.error('Fallback copy failed:', err);
        }
    }

    function showCopiedFeedback(button) {
        var textSpan = button.querySelector('.copy-text');
        var originalText = textSpan.textContent;

        button.classList.add('copied');
        textSpan.textContent = 'Copied';

        setTimeout(function() {
            button.classList.remove('copied');
            textSpan.textContent = originalText;
        }, 2000);
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCopyButtons);
    } else {
        initCopyButtons();
    }

    // Re-initialize for dynamically added content (e.g., inlines)
    if (typeof django !== 'undefined' && django.jQuery) {
        django.jQuery(document).on('formset:added', function() {
            initCopyButtons();
        });
    }
})();
