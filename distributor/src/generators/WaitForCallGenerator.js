import { StringBuilder } from "./generator-utils.js";
import FunctionGenerator from "./FunctionGenerator.js";
import fs from "fs";
import beautify from "js-beautify";

export default class WaitForCallGenerator extends FunctionGenerator {
  constructor() {
    super();
    this.functionMap = this.buildFunctionMap(this.functions);
    this.functionsImportedInsideServer = new Set();
    this.filesInitialized = [];
  }

  buildFunctionMap(functions) {
    const functionMap = {};
    functions.forEach((func) => {
      if (!functionMap[func.server]) {
        functionMap[func.server] = [];
      }
      functionMap[func.server].push(func);
    });
    return functionMap;
  }

  generateImports(functionInfo) {
    const filename = `../src-gen/abc.js`;
    const importPath = `./${filename}`;
    const importCode = `import { ${functionInfo.name} } from "${importPath}";`;

    // Verificar se a importação já foi adicionada
    if (!this.functionsImportedInsideServer.has(functionInfo.server)) {
      // Se não foi adicionada, adicione agora
      this.appendString(importCode);
      this.functionsImportedInsideServer.add(functionInfo.server);
    }
  }

  checkDoubleImportAux(importSearched) {
    // le arquivo do servidor correspondente
    const filepath = `./src-gen/start-${this.currentServerName}.js`;
    
    // se arquivo existe e servidor ja foi inicializado (garante que nao esta executando novamente com arquivos existentes em src-gen)
    if (fs.existsSync(filepath) && this.filesInitialized.includes(filepath)) {
        
      try {
        const code = fs.readFileSync(filepath, 'utf8');

        // testa se import sendo feito ja esta nesse arquivo
        if (code.includes(beautify(importSearched, {
          indent_size: 4,
          space_in_empty_paren: true,
        }))) { 
          return true; // se tiver, return true
        } else return false; // se nao tiver, retorna false
      } catch(e) { 
        console.log(e);
        return; 
      }
    } 
    
    return false;
  }

  visitFunctionDeclaration(ctx) {
    const functionName = ctx.identifier().getText();
    const functionInfo = this.functions.find((func) => func.name === functionName);

    if(functionInfo.method.toUpperCase() !== 'RABBIT') return;
    if (functionInfo) {
      const server = this.servers.find((s) => s.id === functionInfo.server && functionInfo.method.toUpperCase() === 'RABBIT');

      if (!server) return;
      if (server) {
        // Gerar imports para todas as funções associadas ao servidor
        for (const func of this.functionMap[server.id]) {
          this.generateImports(func);
        }

       
        this.appendNewLine();

        // Adicionar o import para todas as funções associadas ao servidor
        for (const func of this.functionMap[server.id]) {
          const importCode = `import { ${func.name} } from "./functions-${func.server}.js";`;
          if (func.method.toUpperCase() === 'RABBIT' && !this.checkDoubleImportAux(importCode))
            this.appendString(importCode);
        }
        this.appendNewLine();
        // this.appendString(`import amqp from 'amqplib';`);
        this.appendString(`async function waitForCall${server.id}() {`);
        this.appendString(`  const connection = await amqp.connect("${server.rabbitmq.connectionUrl || 'amqp://localhost'}");`);
        this.appendString(`  console.log("Esperando por chamadas");`);
        this.appendString(`  const channel = await connection.createChannel();`);
        this.appendString(`  let queueName = "${server.rabbitmq.queue}";`);
        this.appendString(`  await channel.assertQueue(queueName, { durable: false });`);
        this.appendString(`  channel.consume(`);
        this.appendString(`    queueName,`);
        this.appendString(`    async (msg) => {`);
        this.appendString(`      if (msg) {`);
        this.appendString(`        console.log("Recebendo chamada");`);
        this.appendString(`        const message = JSON.parse(msg.content.toString());`);

        // Loop pelas funcs associadas ao server
        for (const func of this.functionMap[server.id]) {
          if(func.method.toUpperCase() !== 'RABBIT') continue;
          const parameters = func.parameters.map((param) => param.name).join(', ');

          this.appendString(`        if (message.funcName === "${func.name}" && message.type === "call") {`);
          this.appendString(`          const { ${parameters} } = message.parameters;`);
          this.appendString(`          console.log("Chamando função ${func.name}", ${parameters});`);
          this.appendString(`          const result${func.name} = await ${func.name}(${parameters});`);
          this.appendString(`          const response${func.name} = {`);
          this.appendString(`            funcName: "${func.name}",`);
          this.appendString(`            type: "response",`);
          this.appendString(`            result: result${func.name},`);
          this.appendString(`          };`);
          this.appendString(`          console.log("Enviando resposta para a função ${func.name}");`);
          this.appendString(`          channel.sendToQueue(queueName, Buffer.from(JSON.stringify(response${func.name})));`);
          this.appendString(`        }`);
        }

        this.appendString(`      }`);
        this.appendString(`    }, { noAck: true });`);
        this.appendString(`}`);
        this.appendNewLine();
        this.appendString(`waitForCall${server.id}();`);
        this.appendNewLine();
      } else {
        console.error(`Server not found for function: ${functionName}`);
      }
    } else {
      console.error(`Function not found: ${functionName}`);
    }
  }

  generateFunctions(ctx, filesInitialized) {
    this.visitProgram(ctx);
    this.filesInitialized = filesInitialized;
    if (ctx.sourceElements()) {
      const sourceElements = ctx.sourceElements().children;
      for (let i in sourceElements) {
        if (sourceElements[i].statement().functionDeclaration()) {
          // reinicio de stringBuilder
          this.stringBuilder = new StringBuilder();
          for (let funct of this.functions) {
            if (funct.name === sourceElements[i].statement().functionDeclaration().identifier().getText()) {
              const serverInfo = this.servers.find((server)=> server.id === funct.server);
              // Verifica se o código para este servidor já foi gerado
              if (!this.codeGenerated.has(funct.server) && funct.method.toUpperCase() === 'RABBIT') {
                this.currentServerName = funct.server;
                this.visitFunctionDeclaration(sourceElements[i].statement().functionDeclaration());
                let newCode = this.stringBuilder.toString();
                let existingCode = this.codeGenerated.get(funct.server);
                if (existingCode) {
                  newCode = existingCode + newCode;
                }
                this.codeGenerated.set(funct.server, newCode);
                this.currentServerName = "";
              }
            }
          }
        }
      }
    }
    return this.codeGenerated;
  }
}
