<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';

	const repo = 'https://github.com/malignantz/pdf.garrettholmes.com';
</script>

<svelte:head>
	<title>How your files stay on this device · pdf.garrettholmes.com</title>
	<meta
		name="description"
		content="How pdf.garrettholmes.com keeps your files on your device, and how to check it yourself."
	/>
</svelte:head>

<article class="page">
	<header>
		<p class="kicker"><Icon name="shield-check" size={18} /> Privacy</p>
		<h1>Your files stay on this device</h1>
		<p class="lede">
			Everything this site does to a PDF happens inside your browser. There is no upload step, no server that
			receives your files, and no account. Here is how that is enforced, and how you can check it.
		</p>
	</header>

	<section>
		<h2>How it is enforced</h2>
		<ul class="points">
			<li>
				<strong>The browser blocks outside connections.</strong>
				Every page is sent with a Content-Security-Policy that includes <code>connect-src 'self'</code>
				and <code>default-src 'self'</code>. Your browser refuses any attempt by this page to contact another
				server, even if the code tried to.
			</li>
			<li>
				<strong>Nothing comes from elsewhere.</strong> The PDF engines (qpdf, PDF.js, pdf-lib, MuPDF), fonts and
				icons are part of the site itself, and so is the text reader (Tesseract) that makes scanned pages
				searchable, which runs on your computer like everything else. There is no CDN, no web font service and no
				third-party script.
			</li>
			<li>
				<strong>No analytics, no tracking.</strong> No cookies, no analytics script, no telemetry. The site does
				not know who you are or what you opened.
			</li>
			<li>
				<strong>It works offline.</strong> After the first visit the app is stored on your device and runs with
				no connection at all.
			</li>
			<li>
				<strong>The code is open.</strong> The full source is public under the AGPL-3.0 license:
				<a href={repo} rel="noreferrer">{repo.replace('https://', '')}</a>.
			</li>
		</ul>
	</section>

	<section>
		<h2>What is kept on this device</h2>
		<p class="para">
			So you can pick up where you left off, the files you open and your changes are saved in this browser, on this
			device only. They are never sent anywhere.
		</p>
		<ul class="points">
			<li>
				<strong>Deleted after 7 days</strong> without changes, and at once when you choose Discard, Forget my work or
				Start over, or turn off “Keep my work on this device” (in the workspace, under Settings).
			</li>
			<li>
				<strong>Passwords are never kept.</strong> A file you opened with a password is kept as you gave it, still
				locked, and asks for the password again.
			</li>
			<li>
				<strong>Passwords are never guessed.</strong> A file that needs a password to open still needs that
				password here; the app never guesses or gets around one. Once a file is open, limits it sets on printing or
				copying are not carried into your export.
			</li>
			<li>
				<strong>Private windows</strong> keep nothing once closed. Some browsers, Safari among them, may also clear
				it when the site has not been used for a while.
			</li>
		</ul>
	</section>

	<section>
		<h2>Check it yourself</h2>
		<ol class="steps">
			<li>
				<strong>Watch the network.</strong> Open your browser's developer tools (F12, or right-click and choose
				Inspect), select the <em>Network</em> tab, then add and export a file. Every request goes to
				<code>pdf.garrettholmes.com</code>, and none of them carry your file.
			</li>
			<li>
				<strong>Turn the network off.</strong> Load the site once, then switch on airplane mode or unplug. Open a
				file, edit it and export it. It all still works, because nothing needs a server.
			</li>
			<li>
				<strong>Read the policy.</strong> In the Network tab, select the first request and look at the
				<code>content-security-policy</code> response header.
			</li>
		</ol>
	</section>

	<p class="back"><a href="/">Back to the workspace</a></p>
</article>

<style>
	.page {
		max-width: 40rem;
		margin: 0 auto;
		padding: var(--s-7) calc(var(--s-4) + var(--safe-right)) calc(var(--s-7) + var(--safe-bottom))
			calc(var(--s-4) + var(--safe-left));
	}

	header {
		margin-bottom: var(--s-6);
	}

	.kicker {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-bottom: var(--s-3);
		color: var(--ok);
		font-size: var(--text-caption);
		font-weight: 600;
	}

	h1 {
		font-family: var(--font-serif);
		font-weight: 500;
		font-size: clamp(1.875rem, 1.4rem + 2vw, 2.5rem);
		letter-spacing: -0.012em;
		line-height: 1.12;
	}

	.lede {
		margin-top: var(--s-4);
		font-size: 1.0625rem;
		color: var(--ink-soft);
	}

	section {
		margin-top: var(--s-6);
		padding-top: var(--s-5);
		border-top: 1px solid var(--line);
	}

	h2 {
		font-size: 1.0625rem;
		margin-bottom: var(--s-4);
	}

	.para {
		margin-bottom: var(--s-4);
	}

	ul,
	ol {
		padding: 0;
		list-style: none;
		display: grid;
		gap: var(--s-4);
	}

	li {
		position: relative;
		padding-left: var(--s-5);
	}

	.points li::before {
		content: '';
		position: absolute;
		left: 4px;
		top: 0.62em;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ink-soft);
	}

	.steps {
		counter-reset: step;
	}

	.steps li {
		counter-increment: step;
		padding-left: var(--s-6);
	}

	.steps li::before {
		content: counter(step);
		position: absolute;
		left: 0;
		top: 0.1em;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 1px solid var(--line-strong);
		font-size: var(--text-caption);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	strong {
		font-weight: 600;
	}

	code {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.875em;
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--desk-deep);
		white-space: nowrap;
	}

	a {
		overflow-wrap: anywhere;
	}

	.back {
		margin-top: var(--s-7);
		font-size: var(--text-control);
	}
</style>
