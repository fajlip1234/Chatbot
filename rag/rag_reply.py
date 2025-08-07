import os
import json
import time
from openai import OpenAI
from dotenv import load_dotenv
from chromadb import PersistentClient
from chromadb.utils.embedding_functions import OpenAIEmbeddingFunction

# Load .env variables
load_dotenv()

api_key = os.getenv("OPENAI_API_KEY")
openai = OpenAI(api_key=api_key)

# Setup ChromaDB
client = PersistentClient(path=".chromadb")
embedding_function = OpenAIEmbeddingFunction(api_key=api_key, model_name="text-embedding-3-small")
collection = client.get_or_create_collection(name="flirty", embedding_function=embedding_function)

# Load dataset if collection is empty
if collection.count() == 0:
    with open("flirty-text-bot-fixed-expanded.jsonl", "r") as f:
        data = [json.loads(line) for line in f]

    documents = []
    metadatas = []
    ids = []

    for i, item in enumerate(data):
        messages = item.get("messages", [])
        recent_texts = [m["content"] for m in messages if "content" in m][-4:]
        convo_text = "\n".join(recent_texts)
        documents.append(convo_text)
        metadatas.append({"source": f"line_{i}"})
        ids.append(f"id_{i}")

    collection.add(documents=documents, metadatas=metadatas, ids=ids)

# RAG-based human-like reply generation
def get_human_like_reply(user_input):
    results = collection.query(query_texts=[user_input], n_results=3)
    context = "\n".join(results["documents"][0])

    system_prompt = """
You’re texting someone you like. Keep it real and natural like real texting. Use slang, drop punctuation when it feels right, and sound human.
Don’t ever mention AI or being a bot.
Use emojis lightly, only to set tone.
Don’t agree to meet up, just play with the idea and keep it vague.
Never suggest a date or hang out yourself.
Replies should be flirty and warm, but not too much too soon — it should feel like a gradual flirt.
Sometimes double-text, especially if one part is short and casual.
Always reply in 1–2 casual lines.
"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"{context}\nUser: {user_input}\nYou:"}
    ]

    response = openai.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        temperature=0.85
    )

    reply = response.choices[0].message.content.strip()

    # Remove apostrophes in slang (e.g. relaxin' → relaxin)
    reply = reply.replace("'", "")

    return reply

# Manual test with double-text logic
while True:
    user_input = input("Enter a message: ")
    reply_message = get_human_like_reply(user_input)

    print("Bot is replying...")
    print()

    # Split message if it's double-text-worthy
    reply_message = reply_message.replace("'", "")  # again to be safe

    has_comma = "," in reply_message
    parts = reply_message.split(",")

    if has_comma and len(parts) == 2 and len(parts[1].strip().split(" ")) <= 5:
        first = parts[0].strip()
        second = parts[1].strip()

        print(f"You: {first}")
        time.sleep(2 + int(os.urandom(1)[0] % 3))  # 2-4 sec delay
        print(f"You: {second}")
    else:
        print(f"You: {reply_message}")
    print()
