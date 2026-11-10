# Ficha Virtual v2

Servidor Node.js (sem framework) + banco de dados + front-end estático em `public/`.

- **Contas**: cadastro/login com senha em scrypt e sessão em cookie HttpOnly.
- **Campanhas**: quem cria é o Mestre; os jogadores entram com um código de convite.
- **Permissões no servidor**: toda rota valida a conta e o papel. O mestre administra tudo da campanha; o jogador só edita a própria ficha.
- **Privacidade**: o servidor devolve a outros jogadores somente nome, retrato e atributos. Os demais dados nunca saem do servidor para quem não é dono/mestre.
- **Tempo real**: Server-Sent Events avisam o navegador; ele busca de novo pelas rotas autorizadas.
- **Banco**: PostgreSQL em produção (`DATABASE_URL`); SQLite embutido do Node (>=22.5) para testar localmente.

## Rodar localmente
    node server.js          # http://localhost:3000 (cria data.sqlite)
    node test/smoke.js      # testes de API: contas, permissões, privacidade, tempo real

## Publicar no Render
1. Suba esta pasta para o GitHub (o `package.json` deve ficar na raiz do repositório).
2. No Render: **New +** > **Blueprint**, escolha o repositório. O `render.yaml` cria o serviço web e o banco.
3. Aguarde o deploy e abra o endereço `https://ficha-virtual-xxxx.onrender.com`.
   (Se preferir criar manualmente: Web Service com Build `npm install`, Start `node server.js`, e a variável `DATABASE_URL` apontando para um PostgreSQL.)
