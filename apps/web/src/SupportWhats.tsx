/** WhatsApp de contato e suporte. Para trocar o número, é só aqui. */
export const SUPPORT_WHATSAPP = "5519997339377";
export const SUPPORT_PHONE_LABEL = "(19) 99733-9377";

export const supportLink = (text: string) => `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(text)}`;

/** Balão flutuante do WhatsApp (página inicial e tela Lojas). No celular, só o ícone. */
export function SupportWhats({ text, label = "Fale com a gente" }: { text: string; label?: string }) {
  return (
    <a className="land-whats" href={supportLink(text)} target="_blank" rel="noopener noreferrer" aria-label={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.2-.2-.4-.3Z" /></svg>
      <span>{label}</span>
    </a>
  );
}
