// Importa i moduli necessari
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {BedrockRuntimeClient, InvokeModelCommand} = require("@aws-sdk/client-bedrock-runtime");
const nodemailer = require("nodemailer");

// Inizializza l'SDK di Firebase Admin per interagire con Firestore
admin.initializeApp();

// Configura il client per Amazon Bedrock
// Le credenziali verranno gestite in modo sicuro, non direttamente qui.
const bedrockClient = new BedrockRuntimeClient({
  region: "us-east-1", // Assicurati sia la regione corretta per te
  credentials: {
    accessKeyId: functions.config().aws.key,
    secretAccessKey: functions.config().aws.secret,
  },
});

/**
 * Cloud Function che si attiva alla creazione di un nuovo documento in 'grant_requests'.
 * Questo è il nostro agente AI.
 */
exports.analyzeGrantRequest = functions.firestore
    .document("grant_requests/{requestId}")
    .onCreate(async (snap, context) => {
      // Prende i dati della richiesta appena creata
      const requestData = snap.data().requestData;
      const docRef = snap.ref; // Riferimento al documento per poterlo aggiornare

      functions.logger.info(`Nuova richiesta ricevuta: ${context.params.requestId}`, {structuredData: true});

      // 1. Costruisci il prompt per l'LLM
      const prompt = `
            Sei un consulente senior esperto in finanza agevolata per il mercato italiano.
            Analizza i seguenti dati di un'azienda cliente:
            - Settore: ${requestData.settore}
            - Dimensione: ${requestData.dimensioni}
            - Numero Dipendenti: ${requestData.dipendenti}
            - Area Geografica: ${requestData.area}

            Basandoti su questi dati, identifica i 3 bandi (regionali, nazionali o europei) più pertinenti e attivi in questo momento. Per ogni bando, fornisci una breve descrizione, l'ente erogatore e la data di scadenza.
            
            Fornisci la risposta esclusivamente in formato JSON valido, senza testo introduttivo o conclusivo, seguendo questa struttura esatta:
            {
              "summary": "Un riassunto di una singola frase delle opportunità identificate.",
              "foundBandi": [
                {
                  "nomeBando": "Nome del Bando 1",
                  "ente": "Ente Erogatore 1",
                  "descrizione": "Breve descrizione del bando 1.",
                  "scadenza": "GG/MM/AAAA"
                }
              ]
            }
        `;

      // 2. Prepara e invia la richiesta a Amazon Bedrock
      const params = {
        modelId: "anthropic.claude-v2", // Modello potente per analisi di testo
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          prompt: `\n\nHuman: ${prompt}\n\nAssistant:`,
          max_tokens_to_sample: 2048,
          temperature: 0.5,
        }),
      };

      try {
        const command = new InvokeModelCommand(params);
        const response = await bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));

        // Estrae e pulisce la risposta JSON dall'LLM
        const analysisResult = JSON.parse(responseBody.completion.trim());
        functions.logger.info("Analisi da Bedrock ricevuta:", analysisResult);

        // 3. Aggiorna il documento in Firestore con i risultati
        return docRef.update({
          status: "analysis_complete",
          analysisResult: analysisResult,
        });
      } catch (error) {
        functions.logger.error("Errore durante l'analisi con Bedrock o l'aggiornamento del documento:", error);
        // In caso di errore, aggiorna il documento per segnalare il fallimento
        return docRef.update({
          status: "analysis_failed",
          errorDetails: error.message,
        });
      }
    });

/**
 * Cloud Function searchAgent che utilizza Google Search API e Google Gemini
 */
exports.searchAgent = functions.firestore
    .document("grant_requests/{requestId}")
    .onCreate(async (snap, context) => {
      const requestData = snap.data().requestData;
      const docRef = snap.ref;

      functions.logger.info(`SearchAgent avviato per richiesta: ${context.params.requestId}`);

      try {
        // 1. Costruisci 3 diverse query di ricerca
        const queries = [
          `bandi ${requestData.settore} ${requestData.area} 2024`,
          `finanziamenti ${requestData.dimensioni} ${requestData.settore} Italia`,
          `contributi startup PMI ${requestData.area} ${requestData.settore}`,
        ];

        // 2. Esegui le ricerche su Google
        const rawSearchResults = [];
        const googleApiKey = functions.config().google.search_key;
        const searchEngineId = functions.config().google.search_engine_id;

        for (const query of queries) {
          const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=5`;

          const response = await fetch(searchUrl);
          const data = await response.json();

          if (data.items) {
            data.items.forEach((item) => {
              rawSearchResults.push({
                link: item.link,
                snippet: item.snippet,
              });
            });
          }
        }

        // 3. Combina tutti gli snippet
        const combinedText = rawSearchResults.map((item) => item.snippet).join(" ");
        functions.logger.info(`Raccolti ${rawSearchResults.length} risultati di ricerca`);

        // 4. Prepara il prompt per Gemini
        const geminiPrompt = `
                Analizza il seguente testo che contiene informazioni sui bandi e finanziamenti italiani.
                Estrai i 3 bandi più rilevanti per un'azienda con queste caratteristiche:
                - Settore: ${requestData.settore}
                - Dimensione: ${requestData.dimensioni}
                - Dipendenti: ${requestData.dipendenti}
                - Area: ${requestData.area}

                Testo da analizzare:
                ${combinedText}

                Rispondi SOLO in formato JSON valido:
                {
                  "summary": "Riassunto delle opportunità trovate",
                  "foundBandi": [
                    {
                      "nomeBando": "Nome del bando",
                      "ente": "Ente erogatore",
                      "descrizione": "Descrizione breve",
                      "scadenza": "Data scadenza se disponibile"
                    }
                  ]
                }
            `;

        // 5. Salva i dati intermedi nella sottocollezione analysis_log
        const logData = {
          googleSearchQueries: queries,
          rawSearchResults: rawSearchResults,
          geminiInputPrompt: geminiPrompt,
          timestamp: new Date(),
        };

        await docRef.collection("analysis_log").doc("search_data").set(logData);
        functions.logger.info("Dati intermedi salvati in analysis_log");

        // 6. Invia a Google Gemini
        const geminiApiKey = functions.config().google.gemini_key;
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${geminiApiKey}`;

        const geminiResponse = await fetch(geminiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [{
              parts: [{text: geminiPrompt}],
            }],
          }),
        });

        const geminiData = await geminiResponse.json();
        const analysisText = geminiData.candidates[0].content.parts[0].text;
        const analysisResult = JSON.parse(analysisText.trim());

        functions.logger.info("Analisi da Gemini ricevuta:", analysisResult);

        // 7. Salva il risultato in Firestore
        return docRef.update({
          status: "analysis_complete",
          analysisResult: analysisResult,
        });
      } catch (error) {
        functions.logger.error("Errore durante l'analisi con SearchAgent:", error);
        return docRef.update({
          status: "analysis_failed",
          errorDetails: error.message,
        });
      }
    });

/**
 * Cloud Function notificationAgent che invia email quando l'analisi è completata
 */
exports.notificationAgent = functions.firestore
    .document("grant_requests/{requestId}")
    .onUpdate(async (change, context) => {
      const newData = change.after.data();
      const previousData = change.before.data();

      // Verifica se lo status è cambiato in analysis_complete
      if (newData.status === "analysis_complete" && previousData.status !== "analysis_complete") {
        const docRef = change.after.ref;
        const analysisResult = newData.analysisResult;
        const userEmail = newData.requestData.email;

        functions.logger.info(`Invio email per richiesta: ${context.params.requestId}`);

        try {
          // Configura il trasportatore Nodemailer
          const transporter = nodemailer.createTransporter({
            service: "gmail",
            auth: {
              user: functions.config().email.user,
              pass: functions.config().email.password,
            },
          });

          // Crea il corpo email HTML
          const bandiHtml = analysisResult.foundBandi.map((bando) => `
                    <div style="margin-bottom: 20px; padding: 15px; border-left: 4px solid #10b981; background-color: #f8f9fa;">
                        <h3 style="color: #1f2937; margin: 0 0 10px 0;">${bando.nomeBando}</h3>
                        <p style="color: #6b7280; margin: 5px 0;"><strong>Ente:</strong> ${bando.ente}</p>
                        <p style="color: #6b7280; margin: 5px 0;"><strong>Descrizione:</strong> ${bando.descrizione}</p>
                        ${bando.scadenza ? `<p style="color: #dc2626; margin: 5px 0;"><strong>Scadenza:</strong> ${bando.scadenza}</p>` : ""}
                    </div>
                `).join("");

          const emailHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <div style="background-color: #10b981; color: white; padding: 20px; text-align: center;">
                            <h1 style="margin: 0;">Innovazione & Finanza</h1>
                            <p style="margin: 10px 0 0 0;">Il tuo report personalizzato è pronto!</p>
                        </div>
                        
                        <div style="padding: 20px;">
                            <h2 style="color: #1f2937;">Analisi Completata</h2>
                            <p style="color: #6b7280;">${analysisResult.summary}</p>
                            
                            <h3 style="color: #1f2937; margin-top: 30px;">Bandi Identificati per la Tua Azienda:</h3>
                            ${bandiHtml}
                            
                            <div style="margin-top: 30px; padding: 20px; background-color: #ecfdf5; border-radius: 8px;">
                                <h4 style="color: #065f46; margin: 0 0 10px 0;">Prossimi Passi</h4>
                                <p style="color: #047857; margin: 0;">Il nostro team di esperti è pronto ad assisterti nella preparazione delle domande. Contattaci per una consulenza personalizzata gratuita.</p>
                            </div>
                        </div>
                        
                        <div style="background-color: #f3f4f6; padding: 15px; text-align: center; font-size: 12px; color: #6b7280;">
                            <p>© 2025 Innovazione & Finanza S.r.l. - Tutti i diritti riservati</p>
                        </div>
                    </div>
                `;

          // Invia l'email
          await transporter.sendMail({
            from: functions.config().email.user,
            to: userEmail,
            subject: "🎯 I tuoi bandi personalizzati sono pronti - Innovazione & Finanza",
            html: emailHtml,
          });

          functions.logger.info(`Email inviata con successo a: ${userEmail}`);

          // Aggiorna lo stato del documento
          return docRef.update({
            status: "email_sent",
            emailSentAt: new Date(),
          });
        } catch (error) {
          functions.logger.error("Errore durante l'invio dell'email:", error);
          return docRef.update({
            status: "email_failed",
            emailError: error.message,
          });
        }
      }

      return null;
    });
