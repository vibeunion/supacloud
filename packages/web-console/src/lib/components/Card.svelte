<script lang="ts">
    interface Props {
        children: import('svelte').Snippet;
        class?: string;
        variant?: "glass" | "glow" | "outline" | "ghost";
    }

    let {
        children,
        class: className = "",
        variant = "glass",
    }: Props = $props();
</script>

<div class="card {variant} {className}">
    {@render children()}
</div>

<style>
    .card {
        border-radius: 20px;
        padding: 1.5rem;
        transition: var(--transition);
    }

    .glass {
        background: var(--surface-glass);
        backdrop-filter: blur(12px);
        border: 1px solid var(--border-color);
    }

    .glow:hover {
        box-shadow: 0 0 25px var(--primary-glow);
        border-color: var(--primary-color);
    }

    .outline {
        border: 1px solid var(--border-color);
    }

    .ghost {
        background: transparent;
    }
</style>
