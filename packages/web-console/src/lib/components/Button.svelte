<script lang="ts">
    interface Props {
        children: import('svelte').Snippet;
        onclick?: () => void;
        type?: "button" | "submit";
        variant?: "primary" | "secondary" | "danger" | "ghost";
        size?: "sm" | "md" | "lg";
        class?: string;
        disabled?: boolean;
    }

    let {
        children,
        onclick,
        type = "button",
        variant = "primary",
        size = "md",
        class: className = "",
        disabled = false,
    }: Props = $props();
</script>

<button {type} {onclick} {disabled} class="btn {variant} {size} {className}">
    {@render children()}
</button>

<style>
    .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border-radius: 10px;
        font-weight: 600;
        cursor: pointer;
        transition: var(--transition);
        white-space: nowrap;
    }

    .primary {
        background: linear-gradient(
            135deg,
            var(--primary-color),
            var(--secondary-color)
        );
        color: white;
        box-shadow: 0 4px 15px rgba(99, 102, 241, 0.2);
    }

    .primary:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(99, 102, 241, 0.4);
    }

    .secondary {
        background: var(--surface-light);
        color: white;
        border: 1px solid var(--border-color);
    }

    .secondary:hover:not(:disabled) {
        background: var(--surface-light);
        border-color: var(--primary-color);
        color: var(--primary-color);
    }

    .danger {
        background: rgba(239, 68, 68, 0.1);
        color: var(--error-color);
        border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .danger:hover:not(:disabled) {
        background: var(--error-color);
        color: white;
    }

    .ghost {
        background: transparent;
        color: var(--text-secondary);
    }

    .ghost:hover:not(:disabled) {
        background: var(--surface-light);
        color: var(--text-primary);
    }

    .sm {
        padding: 6px 12px;
        font-size: 0.85rem;
    }
    .md {
        padding: 10px 20px;
        font-size: 0.9rem;
    }
    .lg {
        padding: 14px 28px;
        font-size: 1rem;
    }

    .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
</style>
