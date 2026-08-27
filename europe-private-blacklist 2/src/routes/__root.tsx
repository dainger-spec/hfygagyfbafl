import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import appCss from "../styles.css?url";

const APP_NAME = "Europe Private Blacklist";

const TG_BOOT = `(function(){try{var h=location.hash||"";if(h.indexOf("tgWebApp")!==-1){try{sessionStorage.setItem("__tg_hash",h);}catch(e){}}else{var s="";try{s=sessionStorage.getItem("__tg_hash")||"";}catch(e){}if(s){history.replaceState(null,"",location.pathname+location.search+s);h=s;}}var q=new URLSearchParams(h.replace(/^#/,""));var d=q.get("tgWebAppData");if(!d)return;var u=new URLSearchParams(d).get("user");if(!u)return;window.__EPB_TG_USER=JSON.parse(u);}catch(e){}})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: APP_NAME },
      { name: "theme-color", content: "#080808" },
      {
        name: "description",
        content: "Закрытый европейский блеклист. Заявка, арбитраж, публикация.",
      },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
    scripts: [{ children: TG_BOOT }, { src: "https://telegram.org/js/telegram-web-app.js" }],
  }),
  component: () => (
    <html lang="ru" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-bg font-sans text-fg">
        <PreviewHostBridge />
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
